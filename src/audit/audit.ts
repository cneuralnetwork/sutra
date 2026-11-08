import type { CompactionRecord, SessionRecord, SessionStore, ToolInvocationRecord, UsageRecord } from "../memory/store.js";
import type { Message } from "../providers/types.js";
import type { UsageTotals } from "../telemetry/cost.js";
import type { Verification } from "../quality/types.js";

/**
 * A complete, reasoning-free record of one session, built only from what the
 * harness persisted: messages, tool invocations (with arguments, results and
 * timings), per-request usage and cost, and compactions.
 */
export interface AuditTool {
  toolCallId: string;
  name: string;
  arguments: unknown;
  status: ToolInvocationRecord["status"] | "unrecorded";
  output: string;
  data?: Record<string, unknown>;
  startedAt?: string;
  durationMs?: number;
}

export interface AuditStep {
  /** The model's visible text for this step (never its private reasoning). */
  text: string;
  at: string;
  usage?: UsageRecord;
  tools: AuditTool[];
}

export interface AuditTurn {
  index: number;
  prompt: string;
  at: string;
  steps: AuditStep[];
  /** Harness notes injected into the conversation (continuation prompts). */
  notes: string[];
}

export interface SessionAudit {
  schema: "sutra.session-audit/v1";
  generatedAt: string;
  session: SessionRecord;
  totals: UsageTotals;
  turns: AuditTurn[];
  compactions: CompactionRecord[];
  /** Usage rows that could not be paired with an assistant message (e.g. interrupted requests). */
  unpairedUsage: UsageRecord[];
  filesChanged: string[];
  commands: { command: string; exitCode: number | null; durationMs: number | null; sandbox?: string }[];
  privacy: string;
  verifications: { turn: number; verification: Verification }[];
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function buildAudit(store: SessionStore, sessionId: string): SessionAudit {
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`No session matching "${sessionId}"`);
  const messages = store.loadMessages(session.id);
  const invocations = new Map(store.listToolInvocations(session.id).map((t) => [t.toolCallId, t]));
  const usage = store.listUsage(session.id);
  const turns: AuditTurn[] = [];
  let current: AuditTurn | null = null;
  let assistantIndex = 0;
  const files = new Set<string>();
  const commands: SessionAudit["commands"] = [];

  const ensureTurn = (at: string): AuditTurn => {
    if (!current) {
      current = { index: turns.length + 1, prompt: "(resumed mid-turn)", at, steps: [], notes: [] };
      turns.push(current);
    }
    return current;
  };

  for (const { message, createdAt } of messages as { message: Message; createdAt: string }[]) {
    if (message.role === "user") {
      if (message.content.startsWith("[Sutra:")) {
        ensureTurn(createdAt).notes.push(message.content);
        continue;
      }
      current = { index: turns.length + 1, prompt: message.content, at: createdAt, steps: [], notes: [] };
      turns.push(current);
    } else if (message.role === "assistant") {
      const turn = ensureTurn(createdAt);
      const tools: AuditTool[] = (message.toolCalls ?? []).map((c) => {
        const inv = invocations.get(c.id);
        if (inv) {
          const files_ = inv.data?.files;
          if (inv.status === "ok" && Array.isArray(files_)) for (const f of files_) files.add(String(f));
          if (inv.data && "command" in inv.data && "exitCode" in inv.data)
            commands.push({
              command: String(inv.data.command),
              exitCode: (inv.data.exitCode as number | null) ?? null,
              durationMs: (inv.data.durationMs as number | null) ?? null,
              ...(inv.data.sandbox ? { sandbox: String(inv.data.sandbox) } : {}),
            });
          // Use the persisted (redacted) arguments from the invocation record.
          return { toolCallId: c.id, name: c.name, arguments: parseArgs(inv.arguments), status: inv.status, output: inv.output, ...(inv.data ? { data: inv.data } : {}), startedAt: inv.startedAt, durationMs: inv.durationMs };
        }
        // Fallback to message arguments (already redacted at persistence time).
        return { toolCallId: c.id, name: c.name, arguments: parseArgs(c.arguments), status: "unrecorded" as const, output: "" };
      });
      const u = usage[assistantIndex];
      assistantIndex++;
      turn.steps.push({ text: message.content, at: createdAt, ...(u ? { usage: u } : {}), tools });
    } else if (message.role === "tool") {
      // Results for calls without an invocation record (repaired after an interruption).
      const turn = ensureTurn(createdAt);
      for (const step of turn.steps) {
        const t = step.tools.find((x) => x.toolCallId === message.toolCallId && x.status === "unrecorded");
        if (t) t.output = message.content;
      }
    }
  }

  return {
    schema: "sutra.session-audit/v1",
    generatedAt: new Date().toISOString(),
    session,
    totals: store.usageTotals(session.id),
    turns,
    compactions: store.listCompactions(session.id),
    unpairedUsage: usage.slice(assistantIndex),
    filesChanged: [...files],
    commands,
    verifications: store.listVerifications<Verification>(session.id).map((x) => ({ turn: x.turn, verification: x.verification })),
    privacy: "Private model reasoning is stored locally for protocol-correct resumption but is excluded from this audit. Tool output was redacted for known secrets when it was recorded.",
  };
}
