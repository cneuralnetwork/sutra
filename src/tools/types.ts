import type { z } from "zod";
import type { PermissionCategory, PermissionRequest } from "../permissions/engine.js";
import type { SecretRedactor } from "../permissions/sensitive.js";
import type { Workspace } from "../permissions/paths.js";
import type { PlanStore } from "../core/planning/plan.js";
import type { FileStateTracker } from "./file-state.js";
import type { SandboxRunner } from "../sandbox/sandbox.js";
import type { RepoIndexService } from "../index/service.js";
import type { HypothesisLedger } from "../quality/ledger.js";

export interface ToolContext {
  workspace: Workspace;
  fileState: FileStateTracker;
  plan: PlanStore;
  redactor: SecretRedactor;
  signal: AbortSignal;
  sessionId: string;
  toolCallId: string;
  settings: {
    commandTimeoutMs: number;
    maxOutputChars: number;
    retainFullLogs: boolean;
    testCommand?: string;
    scrubEnv: boolean;
    logDir: string;
  };
  /** Live output from long-running tools (shell). UI only; not sent to the model. */
  onProgress?: (chunk: string) => void;
  /** OS sandbox for shell commands; null when unavailable or disabled. */
  sandbox?: SandboxRunner | null;
  /** Refuse to run commands when no sandbox is available. */
  sandboxRequired?: boolean;
  /** This call was approved as a network command, so the sandbox lets it out. */
  allowNetwork?: boolean;
  /** Repository index for repo_map / find_symbol / code_search (absent when disabled). */
  repoIndex?: RepoIndexService | null;
  /** Hypothesis ledger for the hypotheses tool. */
  hypotheses?: HypothesisLedger | null;
  /** Full output of an earlier call (get_output). */
  outputs?: (callId: string) => string | undefined;
}

export type ToolErrorCode =
  | "invalid_arguments"
  | "unknown_tool"
  | "permission_denied"
  | "user_rejected"
  | "not_found"
  | "conflict"
  | "stale_file"
  | "path_violation"
  | "timeout"
  | "cancelled"
  | "execution_failed"
  | "loop_detected"
  | "budget_exceeded"
  | "internal_error";

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model (already bounded and redacted by the runtime). */
  output: string;
  /** Structured data for UI and persistence (diffs, exit codes, counts). */
  data?: Record<string, unknown>;
  error?: { code: ToolErrorCode; message: string; retryable: boolean };
}

export interface ToolPreview {
  /** Short description, e.g. "+8 / -3 lines in src/auth/session.ts". */
  summary: string;
  diff?: string;
  details?: string[];
}

export interface Tool<A = unknown> {
  name: string;
  description: string;
  version: string;
  schema: z.ZodType<A>;
  /**
   * Model-visible JSON Schema for the arguments. Tools that wrap an external
   * protocol (MCP) keep the server's original schema so the model sees the
   * exact contract; `schema` still validates the arguments in the harness.
   */
  parameters?: Record<string, unknown>;
  category: PermissionCategory;
  /** Read-only tools may run in parallel with each other. */
  readOnly: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Describe what this call touches so the permission engine can decide. */
  describe(args: A, ctx: ToolContext): PermissionRequest;
  /** Optional dry-run used to render approval prompts (diffs etc.). */
  preview?(args: A, ctx: ToolContext): Promise<ToolPreview>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(output: string, data?: Record<string, unknown>): ToolResult {
  return data ? { ok: true, output, data } : { ok: true, output };
}

export function fail(code: ToolErrorCode, message: string, opts: { retryable?: boolean; data?: Record<string, unknown> } = {}): ToolResult {
  return {
    ok: false,
    output: `Error (${code}): ${message}`,
    error: { code, message, retryable: opts.retryable ?? false },
    ...(opts.data ? { data: opts.data } : {}),
  };
}

export class ToolFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}
