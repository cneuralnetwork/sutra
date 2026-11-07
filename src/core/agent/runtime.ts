import type { SutraConfig } from "../../config/schema.js";
import type { ContextManager } from "../../context/manager.js";
import type { SessionStore } from "../../memory/store.js";
import type { ApprovalChoice, PermissionEngine } from "../../permissions/engine.js";
import { PathViolation, type Workspace } from "../../permissions/paths.js";
import type { SecretRedactor } from "../../permissions/sensitive.js";
import { ProviderError } from "../../providers/errors.js";
import { generateWithRetry, type RetryPolicy, type sleep } from "../../providers/retry.js";
import type { AssistantMessage, FinishReason, Message, ModelProvider, ModelRequest, TokenUsage, ToolCall } from "../../providers/types.js";
import { estimateCost, type UsageTracker } from "../../telemetry/cost.js";
import { log } from "../../telemetry/logger.js";
import type { FileStateTracker } from "../../tools/file-state.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { ToolFailure, fail, type Tool, type ToolContext, type ToolResult } from "../../tools/types.js";
import { oneLine, truncateMiddle } from "../../utils/text.js";
import type { AgentEvent, AgentListener, AgentStatus, ApprovalRequest, TerminalStatus, TurnMode, TurnResult } from "../events/types.js";

/** Prepended to the user's request in plan mode (stored in history so the model knows why writes are refused). */
export const PLAN_MODE_PREFIX =
  "[Sutra plan mode] Investigate as much as you need with read-only tools, then call update_plan with concrete, verifiable steps (files to change, how each step will be checked) and reply with a short summary of the approach and any open questions. Do not modify files or run commands: the harness refuses them until the user approves the plan.";
import type { PlanStore } from "../planning/plan.js";
import { LoopDetector } from "./loop-detector.js";
import type { SandboxStatus } from "../../sandbox/sandbox.js";
import type { RepoIndexService } from "../../index/service.js";
import type { QualityEngine, TurnQuality } from "../../quality/engine.js";
import type { HypothesisLedger } from "../../quality/ledger.js";
import type { Verification } from "../../quality/types.js";
import type { UsageTotals } from "../../telemetry/cost.js";
import type { TestCounts } from "../../tools/shell/test-counts.js";
import type { ContextCompiler } from "../../context/compiler.js";
import type { MapDecision } from "../../context/focus-map.js";
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "../../utils/text.js";

export interface RuntimeDeps {
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  context: ContextManager;
  store: SessionStore | null;
  sessionId: string;
  workspace: Workspace;
  fileState: FileStateTracker;
  plan: PlanStore;
  redactor: SecretRedactor;
  usage: UsageTracker;
  config: SutraConfig;
  /** Asks the user. Non-interactive front-ends should resolve "deny". */
  approve: (req: ApprovalRequest) => Promise<ApprovalChoice>;
  systemPrompt: () => string;
  toolLogDir: string;
  retryPolicy?: RetryPolicy;
  sleepFn?: typeof sleep;
  /** Repository index shared by the code-navigation tools. */
  repoIndex?: RepoIndexService | null;
  /** Quality engine: evidence packet, finish gate, verifier, competing patches. */
  quality?: QualityEngine | null;
  /** Hypothesis ledger for the hypotheses tool. */
  ledger?: HypothesisLedger | null;
  /** OS sandbox for shell commands (absent in delegated tasks and some tests). */
  sandbox?: SandboxStatus;
  /** Default timeout for tools without their own policy. */
  defaultToolTimeoutMs?: number;
  /** Decides what each tool result costs in context: deltas, dedupe, full output on demand. */
  compiler?: ContextCompiler | null;
  /** Per-request repository map decision (index.mapMode "auto"). */
  focusMap?: ((input: string, followUp: boolean) => MapDecision) | null;
}

interface PreparedCall {
  call: ToolCall;
  tool?: Tool<any>;
  args?: unknown;
  /** Set when the call is resolved without executing (invalid, denied, ...). */
  result?: ToolResult;
  outcome?: "error" | "denied" | "cancelled";
  deniedBy?: "user" | "policy";
  /** Approved as a network command: the sandbox lets this one call out. */
  allowNetwork?: boolean;
  summary: string;
  /** What enters history for this call (compiled once, never rewritten). */
  content?: string;
}

interface TurnState {
  iterations: number;
  toolCalls: number;
  filesChanged: Set<string>;
  tests: TurnResult["testsRun"];
  finalText: string;
  costAtStart: number;
  inputAtStart: number;
  outputAtStart: number;
  cachedAtStart: number;
  startedAt: number;
  lengthContinuations: number;
  quality: TurnQuality | null;
  verification?: Verification | null;
  contextMap?: { included: boolean; reason: string };
}

const MAX_STREAM_RESETS = 2;

/**
 * The agent loop: context → inference → validation → permission → execution
 * → observation → (repeat) → terminal state.
 *
 * Invariants:
 *  - Every tool call id in an assistant message receives exactly one tool
 *    result message, including failures, denials and cancellations.
 *  - A turn always ends in an explicit terminal status.
 *  - Partial streamed output is never persisted as if it were complete.
 */
export class AgentRuntime {
  private listeners = new Set<AgentListener>();
  private _status: AgentStatus = "idle";
  private turn = 0;
  private running = false;
  private loop = new LoopDetector();
  private budgetWarned = false;
  private sessionFiles = new Set<string>();
  private sessionCommands: { command: string; exitCode: number | null }[] = [];
  private recentErrors: string[] = [];
  model: string;
  private mode: TurnMode = "normal";

  constructor(private readonly d: RuntimeDeps) {
    this.model = d.config.model!;
    d.plan.subscribe((plan) => {
      d.store?.savePlan(d.sessionId, plan);
      this.emit({ type: "plan", plan });
    });
  }

  get status(): AgentStatus {
    return this._status;
  }
  get sessionId(): string {
    return this.d.sessionId;
  }
  get isRunning(): boolean {
    return this.running;
  }

  on(l: AgentListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        log().error({ err }, "listener failed");
      }
    }
  }

  private setStatus(s: AgentStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit({ type: "status", status: s });
  }

  /** Estimated prompt tokens of the next request (system prompt + history + tools). */
  contextTokens(): number {
    return this.d.context.estimate(this.d.systemPrompt(), this.d.tools.definitions());
  }

  setModel(model: string): void {
    this.model = model;
    this.d.store?.updateSession(this.d.sessionId, { model });
  }

  private append(message: Message): void {
    const seq = this.d.store?.appendMessage(this.d.sessionId, message);
    this.d.context.append(message, seq);
  }

  // ------------------------------------------------------------------ turn

  /**
   * Run one user turn. In plan mode the model may read the workspace and call
   * update_plan, but every file change and command is refused by the harness;
   * the user reviews the plan before anything happens.
   */
  async runTurn(input: string, signal?: AbortSignal, opts: { mode?: TurnMode } = {}): Promise<TurnResult> {
    if (this.running) throw new Error("A turn is already running");
    this.running = true;
    this.turn++;
    this.mode = opts.mode ?? "normal";
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const totals = this.d.usage.totals;
    const st: TurnState = {
      iterations: 0,
      toolCalls: 0,
      filesChanged: new Set(),
      tests: [],
      finalText: "",
      costAtStart: totals.costUsd,
      inputAtStart: totals.inputTokens,
      outputAtStart: totals.outputTokens,
      cachedAtStart: totals.cachedInputTokens,
      startedAt: Date.now(),
      lengthContinuations: 0,
      quality: this.d.quality?.startTurn(input, (opts.mode ?? "normal") === "plan") ?? null,
    };
    this.loop.reset();
    // The user may have changed files between turns.
    this.d.compiler?.advance();
    this.emit({ type: "turn_start", turn: this.turn, input, mode: this.mode });

    try {
      const over = this.budgetExceeded();
      if (over) return this.finish(st, "budget_exceeded", over);
      if (this.d.store && this.turn === 1 && !this.d.store.getSession(this.d.sessionId)?.title)
        this.d.store.updateSession(this.d.sessionId, { title: oneLine(input, 80) });
      let evidence: string | null = null;
      if (st.quality) {
        try {
          evidence = await st.quality.begin(ac.signal);
        } catch (err) {
          if (ac.signal.aborted) throw err;
          this.emit({ type: "notice", level: "warn", message: `Evidence packet unavailable: ${(err as Error).message}` });
        }
      }
      let map: MapDecision | null = null;
      try {
        map = this.d.focusMap?.(input, this.d.context.messages().some((m) => m.role === "user")) ?? null;
      } catch (err) {
        log().warn({ err: (err as Error).message }, "focus map failed");
      }
      if (map) st.contextMap = { included: !!map.text, reason: map.reason };
      // Stable prefix first (system prompt, tools, history); this request's evidence goes last.
      const body = this.mode === "plan" ? `${PLAN_MODE_PREFIX}\n\n${input}` : input;
      this.append({ role: "user", content: [body, evidence, map?.text].filter(Boolean).join("\n\n") });
      this.d.store?.updateSession(this.d.sessionId, { status: "running" });
      return await this.loopTurn(st, ac.signal);
    } catch (err) {
      this.resolveDangling(ac.signal.aborted ? "cancelled" : "error");
      if (ac.signal.aborted || (err instanceof ProviderError && err.kind === "cancelled")) return this.finish(st, "cancelled", "Cancelled by user");
      const msg = err instanceof Error ? err.message : String(err);
      log().error({ err: msg }, "turn failed");
      return this.finish(st, "failed", msg);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.running = false;
    }
  }

  private budgetExceeded(): string | null {
    const limit = this.d.config.budget.maxSessionCostUsd;
    if (limit !== undefined && this.d.usage.totals.costUsd >= limit)
      return `Session spend $${this.d.usage.totals.costUsd.toFixed(4)} reached the budget of $${limit.toFixed(2)}. Inference is paused; raise the limit with /budget <usd> to continue.`;
    return null;
  }

  private async loopTurn(st: TurnState, signal: AbortSignal): Promise<TurnResult> {
    const { budget } = this.d.config;
    while (true) {
      if (signal.aborted) return this.finish(st, "cancelled", "Cancelled by user");
      if (st.iterations >= budget.maxIterationsPerTurn)
        return this.finish(st, "budget_exceeded", `Stopped after ${st.iterations} model iterations (limit budget.maxIterationsPerTurn). Say "continue" to proceed.`);
      const over = this.budgetExceeded();
      if (over) return this.finish(st, "budget_exceeded", over);

      const tools = this.d.tools.definitions();
      let system = this.d.systemPrompt();
      if (this.d.context.shouldCompact(system, tools)) {
        await this.compact(false, signal);
        system = this.d.systemPrompt();
      }

      for (const note of st.quality?.takeNotes() ?? []) this.append({ role: "user", content: note });
      st.iterations++;
      this.setStatus("thinking");
      const messages = this.d.context.build(system);
      const estimate = this.d.context.estimator.estimateMessages(messages, tools);
      this.emit({ type: "inference_start", iteration: st.iterations, estimatedInputTokens: estimate });

      const info = this.d.provider.getModelInfo(this.model);
      const thinking = info.supportsThinking ? this.d.config.thinking : undefined;
      const request: ModelRequest = {
        model: this.model,
        messages,
        tools,
        maxOutputTokens: Math.min(this.d.config.maxOutputTokens ?? info.defaultOutputTokens, info.maxOutputTokens),
        ...(thinking ? { thinking } : {}),
        ...(thinking === "enabled" ? { reasoningEffort: this.d.config.reasoningEffort } : {}),
      };

      const started = performance.now();
      const res = await this.infer(request, signal);
      const latency = performance.now() - started;
      this.recordUsage(res.model, res.usage, latency, estimate);

      const message = this.normalizeCalls(res.message);
      this.append(message);
      st.finalText = message.content;
      this.emit({
        type: "assistant_message",
        content: message.content,
        toolCalls: (message.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name })),
        finishReason: res.finishReason,
      });

      if (!message.toolCalls?.length) {
        if (res.finishReason === "length" && st.lengthContinuations < 1) {
          st.lengthContinuations++;
          this.emit({ type: "notice", level: "warn", message: "Response hit the output token limit; asking the model to continue." });
          this.append({ role: "user", content: "[Sutra: your previous response was cut off by the output token limit. Continue exactly where you stopped.]" });
          continue;
        }
        if (res.finishReason === "content_filter") return this.finish(st, "failed", "The provider stopped the response (content filter).");
        if (res.finishReason === "insufficient_resources") return this.finish(st, "failed", "The provider reported insufficient system resources. Try again shortly.");
        if (res.finishReason === "length") return this.finish(st, "failed", "The response was truncated by the output token limit.");
        // The model stopping is a claim, not a result: the harness checks the evidence.
        if (st.quality) {
          this.setStatus("executing");
          const decision = await st.quality.finish(message.content, signal);
          if (decision.action === "continue") {
            this.append({ role: "user", content: decision.message });
            continue;
          }
          st.verification = decision.verification;
        }
        return this.finish(st, "completed");
      }

      this.setStatus("executing");
      await this.executeToolCalls(message.toolCalls, st, signal);
      this.d.store?.saveCheckpoint(this.d.sessionId, {
        status: "executing",
        turn: this.turn,
        iteration: st.iterations,
        fileState: this.d.fileState.toJSON(),
      });
      if (signal.aborted) return this.finish(st, "cancelled", "Cancelled by user");
      await this.checkpoint(message.toolCalls, st, signal);
      if (this.loop.exhausted) return this.finish(st, "failed", "Stopped: the model kept repeating identical tool calls without progress.");
      if (st.toolCalls >= budget.maxToolCallsPerTurn)
        return this.finish(st, "budget_exceeded", `Stopped after ${st.toolCalls} tool calls (limit budget.maxToolCallsPerTurn). Say "continue" to proceed.`);
    }
  }

  private async infer(request: ModelRequest, signal: AbortSignal): Promise<{ message: AssistantMessage; finishReason: FinishReason; usage: TokenUsage | null; model: string }> {
    for (let resets = 0; ; resets++) {
      try {
        for await (const ev of generateWithRetry(this.d.provider, request, {
          signal,
          ...(this.d.retryPolicy ? { policy: this.d.retryPolicy } : {}),
          ...(this.d.sleepFn ? { sleepFn: this.d.sleepFn } : {}),
          onRetry: (n) => this.emit({ type: "inference_retry", attempt: n.attempt, delayMs: n.delayMs, reason: n.error.message }),
        })) {
          switch (ev.type) {
            case "text_delta":
              this.emit({ type: "text_delta", text: ev.text });
              break;
            case "reasoning_delta":
              this.emit({ type: "reasoning_progress", chars: ev.chars });
              break;
            case "tool_call_start":
              this.emit({ type: "tool_call_streaming", name: ev.name });
              break;
            case "message_complete":
              return { message: ev.message, finishReason: ev.finishReason, usage: ev.usage, model: ev.model };
          }
        }
        throw new ProviderError("protocol", "Stream ended without a complete message");
      } catch (err) {
        if (err instanceof ProviderError && err.partial && err.retryable && resets < MAX_STREAM_RESETS && !signal.aborted) {
          this.emit({ type: "stream_reset", reason: err.message });
          continue;
        }
        throw err;
      }
    }
  }

  /** Ensure every tool call has a unique, non-empty id before it is persisted. */
  private normalizeCalls(m: AssistantMessage): AssistantMessage {
    if (!m.toolCalls) return m;
    const seen = new Set<string>();
    m.toolCalls = m.toolCalls.map((c, i) => {
      let id = c.id || `call_${this.turn}_${i}`;
      while (seen.has(id)) id = `${id}_${i}`;
      seen.add(id);
      return { ...c, id };
    });
    return m;
  }

  /** Usage of a harness-made model call (contract, judge, review): counted in cost, not used for calibration. */
  recordAuxiliaryUsage(model: string, usage: TokenUsage | null, latencyMs: number): number | null {
    return this.recordUsage(model, usage, latencyMs, -1);
  }

  /** Fold a sub-agent's totals (verifier, candidates) into this session's spend. Their detail lives in their own sessions. */
  recordSubAgentUsage(t: UsageTotals): void {
    this.d.usage.merge(t);
    this.d.store?.recordUsage(
      this.d.sessionId,
      `${this.model} (sub-agents)`,
      { inputTokens: t.inputTokens, outputTokens: t.outputTokens, reasoningTokens: t.reasoningTokens, cachedInputTokens: t.cachedInputTokens },
      t.modelLatencyMs,
      t.costIncomplete ? null : t.costUsd,
    );
    this.emit({ type: "usage", usage: null, costUsd: t.costUsd, latencyMs: t.modelLatencyMs, totals: { ...this.d.usage.totals } });
  }

  /** Quality-engine progress, shown in the thread. */
  emitQuality(e: { stage: string; message: string; level: "info" | "warn" }): void {
    this.emit({ type: "quality", ...e });
  }

  private recordUsage(model: string, usage: TokenUsage | null, latencyMs: number, estimate: number): number | null {
    const price = this.d.config.pricing[model] ?? this.d.config.pricing[this.model];
    // Local inference has no per-token price unless the user configured one.
    const cost = usage ? (price ? estimateCost(usage, price) : this.d.provider.freeOfCharge ? 0 : null) : null;
    this.d.usage.recordRequest(usage, latencyMs, cost);
    this.d.store?.recordUsage(this.d.sessionId, model, usage, latencyMs, cost);
    if (usage && estimate >= 0) this.d.context.estimator.calibrate(estimate, usage.inputTokens);
    this.emit({ type: "usage", usage, costUsd: cost, latencyMs, totals: { ...this.d.usage.totals } });
    const limit = this.d.config.budget.maxSessionCostUsd;
    if (limit && !this.budgetWarned && this.d.usage.totals.costUsd >= limit * this.d.config.budget.warnAtFraction) {
      this.budgetWarned = true;
      this.emit({ type: "budget_warning", spentUsd: this.d.usage.totals.costUsd, limitUsd: limit });
    }
    return cost;
  }

  // ----------------------------------------------------------------- tools

  private prepare(call: ToolCall): PreparedCall {
    const tool = this.d.tools.get(call.name);
    if (!tool) {
      return { call, summary: call.name, outcome: "error", result: fail("unknown_tool", `Unknown tool "${call.name}". Available: ${this.d.tools.list().map((t) => t.name).join(", ")}`) };
    }
    let raw: unknown;
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      return { call, tool, summary: call.name, outcome: "error", result: fail("invalid_arguments", `Arguments are not valid JSON (possibly truncated): ${truncateMiddle(call.arguments, 300).text}`) };
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { call, tool, summary: call.name, outcome: "error", result: fail("invalid_arguments", `Invalid arguments for ${call.name}: ${issues}`) };
    }
    return { call, tool, args: parsed.data, summary: call.name };
  }

  private toolContext(callId: string, signal: AbortSignal, allowNetwork = false): ToolContext {
    const t = this.d.config.tools;
    return {
      workspace: this.d.workspace,
      fileState: this.d.fileState,
      plan: this.d.plan,
      redactor: this.d.redactor,
      signal,
      sessionId: this.d.sessionId,
      toolCallId: callId,
      settings: {
        commandTimeoutMs: t.commandTimeoutMs,
        maxOutputChars: t.maxOutputChars,
        retainFullLogs: t.retainFullLogs,
        scrubEnv: t.scrubEnv,
        logDir: this.d.toolLogDir,
        ...(t.testCommand ? { testCommand: t.testCommand } : {}),
      },
      sandbox: this.d.sandbox?.runner ?? null,
      repoIndex: this.d.repoIndex ?? null,
      hypotheses: this.d.ledger ?? null,
      outputs: (id) => this.d.compiler?.output(id),
      sandboxRequired: this.d.sandbox?.mode === "required",
      allowNetwork,
      onProgress: (chunk) => this.emit({ type: "tool_progress", toolCallId: callId, chunk: this.d.redactor.redact(chunk) }),
    };
  }

  /** Permission phase for one call. Runs sequentially so prompts never overlap. */
  private async authorize(p: PreparedCall, signal: AbortSignal): Promise<void> {
    if (p.result) return;
    const tool = p.tool!;
    if (this.loop.check(p.call.name, p.args)) {
      p.outcome = "error";
      p.result = fail("loop_detected", "This exact call was already made several times with no change in between. Use the earlier result or try a different approach.");
      return;
    }
    const ctx = this.toolContext(p.call.id, signal);
    let req;
    try {
      req = tool.describe(p.args, ctx);
    } catch (err) {
      p.outcome = "error";
      p.result = fail(err instanceof PathViolation ? "path_violation" : "invalid_arguments", (err as Error).message);
      return;
    }
    p.summary = req.summary;
    if (this.mode === "plan" && (tool.category === "write" || tool.category === "execute" || tool.category === "mcp")) {
      p.outcome = "denied";
      p.deniedBy = "policy";
      p.result = fail("permission_denied", "Plan mode: nothing may be changed or run until the user approves the plan. Record the step in update_plan instead.");
      return;
    }
    // Re-running identical tests with nothing changed would only repeat the last result.
    const skip = this.d.compiler?.preempt(tool.name, req.command, !!(p.args as { force?: boolean } | undefined)?.force);
    if (skip) {
      p.result = skip;
      return;
    }
    const decision = this.d.permissions.evaluate(req);
    p.allowNetwork = this.d.config.sandbox.network || !!decision.command?.network;
    const previewCtx = this.toolContext(p.call.id, signal, p.allowNetwork);
    if (decision.verdict === "deny") {
      p.outcome = "denied";
      p.deniedBy = "policy";
      p.result = fail("permission_denied", `Blocked by permission policy (${this.d.permissions.policy.profile} profile): ${decision.reason}. Do not retry this action with another tool.`);
      return;
    }
    if (decision.verdict === "allow") return;

    let preview;
    if (tool.preview) {
      try {
        preview = await tool.preview(p.args, previewCtx);
      } catch (err) {
        // A failing preview (e.g. edit target not found) is the call's result;
        // there's nothing meaningful to approve.
        p.outcome = "error";
        p.result = err instanceof ToolFailure ? fail(err.code, err.message, { retryable: err.retryable }) : fail("execution_failed", (err as Error).message);
        return;
      }
    }
    if (signal.aborted) return;
    this.setStatus("awaiting_approval");
    const choice = await this.d.approve({ toolCallId: p.call.id, tool: tool.name, summary: req.summary, decision, ...(preview ? { preview } : {}) });
    this.setStatus("executing");
    if (choice === "deny") {
      p.outcome = "denied";
      p.deniedBy = "user";
      p.result = fail("user_rejected", "The user declined this action. Ask how they would like to proceed or choose a different approach.");
    } else if (choice === "session" && decision.grantKey) {
      this.d.permissions.grant(decision.grantKey);
    }
  }

  private async run(p: PreparedCall, st: TurnState, signal: AbortSignal): Promise<void> {
    const tool = p.tool!;
    const started = new Date();
    this.emit({ type: "tool_start", toolCallId: p.call.id, name: tool.name, summary: p.summary, args: this.redactForEvent(p.args) });
    const callAc = new AbortController();
    const onAbort = () => callAc.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = tool.timeoutMs ?? (tool.category === "execute" ? 31 * 60_000 : (this.d.defaultToolTimeoutMs ?? 5 * 60_000));
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => {
          callAc.abort();
          resolve(fail("timeout", `${tool.name} exceeded its ${timeoutMs} ms timeout`));
        }, timeoutMs);
      });
      const result = await Promise.race([tool.execute(p.args, this.toolContext(p.call.id, callAc.signal, p.allowNetwork)), timeout]);
      p.result = result;
      if (!result.ok) p.outcome = result.error?.code === "cancelled" ? "cancelled" : "error";
    } catch (err) {
      p.outcome = signal.aborted ? "cancelled" : "error";
      p.result =
        err instanceof ToolFailure
          ? fail(err.code, err.message, { retryable: err.retryable })
          : err instanceof PathViolation
            ? fail("path_violation", err.message)
            : signal.aborted
              ? fail("cancelled", "Cancelled by user")
              : fail("internal_error", `${tool.name} crashed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const durationMs = Date.now() - started.getTime();
    this.d.usage.recordTool(durationMs);
    this.afterTool(p, st);
    this.emit({
      type: "tool_end",
      toolCallId: p.call.id,
      name: tool.name,
      summary: p.summary,
      args: this.redactForEvent(p.args),
      result: this.redactedResult(p.result!),
      durationMs,
      outcome: p.outcome ?? "ok",
    });
    this.persistInvocation(p, started, durationMs);
  }

  /** The bounded, redacted text for history; compiled at the moment the result is known. */
  private contentFor(p: PreparedCall): string {
    const r = p.result!;
    const bounded = truncateMiddle(r.output, this.d.config.tools.maxOutputChars);
    const content = this.d.redactor.redact(bounded.text);
    // A tool may hand over a fuller text for get_output; it never reaches the log unredacted.
    const raw = r.data?.rawOutput;
    if (r.data && "rawOutput" in r.data) delete r.data.rawOutput;
    const full = typeof raw === "string" ? this.d.redactor.redact(raw) : undefined;
    if (!this.d.compiler) return content;
    return this.d.compiler.compile({ callId: p.call.id, name: p.call.name, category: p.tool?.category ?? "internal", result: r, content, truncated: bounded.truncated, ...(full ? { full } : {}) });
  }

  private afterTool(p: PreparedCall, st: TurnState): void {
    const r = p.result!;
    const tool = p.tool!;
    p.content = this.contentFor(p);
    st.quality?.observe({ name: tool.name, category: tool.category, readOnly: tool.readOnly, outcome: p.outcome ?? "ok", result: r });
    if (r.ok && !tool.readOnly && tool.category !== "internal") {
      this.loop.advanceEpoch();
      this.d.repoIndex?.markDirty();
    }
    const files = r.ok ? (r.data?.files as string[] | undefined) : undefined;
    for (const f of files ?? []) {
      st.filesChanged.add(f);
      this.sessionFiles.add(f);
    }
    if (tool.category === "execute" && r.data && "command" in r.data) {
      this.sessionCommands.push({ command: String(r.data.command), exitCode: (r.data.exitCode as number | null) ?? null });
      if (tool.name === "run_tests" || tool.name === "diagnose_failure")
        st.tests.push({ command: String(r.data.command), passed: r.data.exitCode === 0, ...(r.data.counts ? { counts: r.data.counts as TestCounts } : {}) });
    }
    if (!r.ok)
      this.recentErrors = [
        ...this.recentErrors.slice(-9),
        this.d.redactor.redact(`${tool.name}: ${r.error?.message ?? r.output}`),
      ];
  }

  private persistInvocation(p: PreparedCall, started: Date, durationMs: number): void {
    const r = p.result!;
    this.d.store?.recordToolInvocation({
      sessionId: this.d.sessionId,
      toolCallId: p.call.id,
      name: p.call.name,
      arguments: this.d.redactor.redact(p.call.arguments),
      status: p.outcome ?? "ok",
      output: this.d.redactor.redact(r.output),
      ...(r.data ? { data: this.redactForEvent(r.data) as Record<string, unknown> } : {}),
      startedAt: started.toISOString(),
      endedAt: new Date(started.getTime() + durationMs).toISOString(),
      durationMs,
    });
  }

  /**
   * Copy model-supplied data with known secrets replaced. Used for events and
   * persistence so a secret never reaches the UI, JSON output or the database
   * through tool arguments. The depth cap keeps hostile nesting bounded.
   */
  private redactForEvent(value: unknown, depth = 0): unknown {
    if (depth > 20) return "[truncated]";
    if (typeof value === "string") return this.d.redactor.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactForEvent(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactForEvent(v, depth + 1);
      return out;
    }
    return value;
  }

  /** A redacted copy of a tool result for UI events and JSON output. */
  private redactedResult(result: ToolResult): ToolResult {
    return {
      ...result,
      output: this.d.redactor.redact(result.output),
      ...(result.error ? { error: { ...result.error, message: this.d.redactor.redact(result.error.message) } } : {}),
      ...(result.data ? { data: this.redactForEvent(result.data) as Record<string, unknown> } : {}),
    };
  }

  private async executeToolCalls(calls: ToolCall[], st: TurnState, signal: AbortSignal): Promise<void> {
    const prepared = calls.map((c) => this.prepare(c));
    st.toolCalls += calls.length;

    // Consecutive read-only calls form a parallel batch; anything that writes
    // or executes runs alone, in the order the model issued it.
    const batches: PreparedCall[][] = [];
    for (const p of prepared) {
      const last = batches[batches.length - 1];
      const parallel = p.tool?.readOnly && !p.result;
      if (parallel && last && last.every((x) => x.tool?.readOnly && !x.result)) last.push(p);
      else batches.push([p]);
    }

    for (const batch of batches) {
      for (const p of batch) {
        if (signal.aborted) break;
        await this.authorize(p, signal);
      }
      const runnable = batch.filter((p) => !p.result && !signal.aborted);
      await Promise.all(runnable.map((p) => this.run(p, st, signal)));
      for (const p of batch) {
        if (!p.result) {
          p.outcome = "cancelled";
          p.result = fail("cancelled", "Not executed: the user cancelled the turn.");
        }
        if (!runnable.includes(p)) {
          // Resolved without running: still report it to the UI and the log.
          this.emit({
            type: "tool_end",
            toolCallId: p.call.id,
            name: p.call.name,
            summary: p.summary,
            args: this.redactForEvent(p.args),
            result: this.redactedResult(p.result!),
            durationMs: 0,
            outcome: p.outcome ?? "error",
            ...(p.deniedBy ? { deniedBy: p.deniedBy } : {}),
          });
          this.persistInvocation(p, new Date(), 0);
          // Count it like the store does, so /cost, the status bar and bench agree with replay.
          this.d.usage.recordTool(0);
          if (p.tool) this.afterTool(p, st);
        }
      }
    }

    // Exactly one result per call id, in the order the calls were issued.
    for (const p of prepared) {
      const content = p.content ?? this.contentFor(p);
      this.append({ role: "tool", toolCallId: p.call.id, name: p.call.name, content });
    }
  }

  /** Give any dangling tool calls a result so history stays protocol-valid. */
  private resolveDangling(reason: "cancelled" | "error"): void {
    for (const c of this.d.context.unresolvedToolCalls()) {
      this.append({
        role: "tool",
        toolCallId: c.id,
        name: c.name,
        content: reason === "cancelled" ? "Error (cancelled): the user cancelled the turn before this tool ran." : "Error (internal_error): the turn failed before this tool ran.",
      });
    }
  }

  // ------------------------------------------------------------ compaction

  async compact(manual: boolean, signal?: AbortSignal): Promise<boolean> {
    const result = await this.d.context.compact({
      provider: this.d.provider,
      model: this.model,
      systemPrompt: this.d.systemPrompt(),
      tools: this.d.tools.definitions(),
      facts: {
        filesModified: [...this.sessionFiles],
        commands: this.sessionCommands,
        unresolvedErrors: this.recentErrors,
        plan: this.d.plan.get() ? this.d.plan.render() : null,
        evidence: this.evidenceFacts(),
      },
      ...(signal ? { signal } : {}),
    });
    if (result) this.d.compiler?.reset();
    if (!result) {
      if (manual) this.emit({ type: "notice", level: "info", message: "Nothing to compact yet." });
      return false;
    }
    this.d.store?.saveCompaction(this.d.sessionId, { boundarySeq: result.boundarySeq, summary: result.summary, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter });
    this.emit({ type: "compaction", tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, usedModel: result.usedModel, manual });
    return true;
  }

  /**
   * Compact at a natural boundary (tests pass after edits) rather than in the
   * middle of an investigation: the summary then records a settled state, and
   * the cache prefix is rebuilt once, deliberately.
   */
  private async checkpoint(calls: ToolCall[], st: TurnState, signal: AbortSignal): Promise<void> {
    if (!st.filesChanged.size) return;
    const passed = st.tests.length > 0 && st.tests[st.tests.length - 1]!.passed && calls.some((c) => c.name === "run_tests" || c.name === "diagnose_failure");
    if (!passed) return;
    const fill = this.d.context.fill(this.d.systemPrompt(), this.d.tools.definitions());
    if (fill < this.d.config.context.checkpointThreshold) return;
    this.emit({ type: "notice", level: "info", message: `Checkpoint: tests pass after edits and context is ${Math.round(fill * 100)}% full; compacting now.` });
    await this.compact(false, signal);
  }

  /** Facts tied to content hashes, so the compacted context knows exactly what is current. */
  private evidenceFacts(): string[] {
    const out = [...(this.d.compiler?.facts() ?? [])];
    for (const f of [...this.sessionFiles].slice(-20)) {
      try {
        const abs = this.d.workspace.resolve(f).absolute;
        out.push(existsSync(abs) ? `${f} now has content hash ${sha256(readFileSync(abs)).slice(0, 12)} (re-read before editing)` : `${f} no longer exists`);
      } catch {
        /* outside the workspace */
      }
    }
    return out;
  }

  private finish(st: TurnState, status: TerminalStatus, reason?: string): TurnResult {
    this.setStatus(status);
    const t = this.d.usage.totals;
    if (st.verification === undefined && st.quality) st.verification = st.quality.partial();
    if (st.verification) this.d.store?.saveVerification(this.d.sessionId, this.turn, st.verification);
    const result: TurnResult = {
      status,
      mode: this.mode,
      ...(st.verification ? { verification: st.verification } : {}),
      ...(st.contextMap ? { contextMap: st.contextMap } : {}),
      ...(reason ? { reason } : {}),
      iterations: st.iterations,
      toolCalls: st.toolCalls,
      filesChanged: [...st.filesChanged],
      finalText: st.finalText,
      costUsd: t.costUsd - st.costAtStart,
      inputTokens: t.inputTokens - st.inputAtStart,
      outputTokens: t.outputTokens - st.outputAtStart,
      cachedInputTokens: t.cachedInputTokens - st.cachedAtStart,
      durationMs: Date.now() - st.startedAt,
      testsRun: st.tests,
    };
    this.d.store?.updateSession(this.d.sessionId, { status });
    this.d.store?.saveCheckpoint(this.d.sessionId, { status, turn: this.turn, iteration: st.iterations, fileState: this.d.fileState.toJSON(), ...(reason ? { note: reason } : {}) });
    this.emit({ type: "turn_end", result });
    this._status = "idle";
    return result;
  }
}
