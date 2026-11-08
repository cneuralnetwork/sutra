# Architecture

Sutra is a single TypeScript package (strict mode, ESM, Node ≥ 22.13). Its layers talk to each other through typed interfaces. The agent runtime knows nothing about DeepSeek, and the DeepSeek adapter knows nothing about tools or permissions.

```
src/
  cli/          argument parsing, `sutra init`, slash commands, non-interactive mode
  tui/          Ink/React terminal UI, theme, syntax-highlighted diffs
  core/
    agent/      AgentRuntime (the loop), loop detector
    events/     AgentEvent / AgentStatus / TurnResult types
    planning/   PlanStore
    session.ts  wires all layers into a session (new or resumed)
    delegate.ts delegated-task interface (subagent foundation)
  providers/    ModelProvider interface, errors, retry wrapper, registry
    openai-compatible/  generic Chat Completions adapter (fetch + SSE)
    deepseek/   DeepSeek dialect, wire format, SSE parser, model metadata
  sandbox/      OS sandbox: Seatbelt profile (macOS), bubblewrap args (Linux)
  index/        repository index: symbol extraction, reference graph + PageRank map,
                BM25 chunk search, optional embeddings
  quality/      quality engine: evidence packet, finish gate, counterexample verifier,
                competing patches, alignment review, hypothesis ledger, snapshots
  audit/        session audit model, replay timeline, Markdown/JSON export
  bench/        benchmark runner and reports
  tools/        Tool interface, registry, filesystem / shell / git / plan tools
  context/      ContextManager (history, budget, compaction), token estimator,
                instruction loading, system prompt
  memory/       SessionStore (node:sqlite)
  permissions/  PermissionEngine, workspace path canonicalisation,
                command classifier, secret handling
  config/       zod schema, loader with precedence, default pricing
  telemetry/    usage + cost tracking, pino logger
  i18n/         English / Hindi interface strings
```

## The turn loop

`AgentRuntime.runTurn(input, signal)`:

```
user message ──► budget check ──► (compact if over threshold)
     ▲                                   │
     │                          build request (system + history + tools)
     │                                   │
     │                    provider.generate() via generateWithRetry
     │                                   │
     │                 assistant message persisted (with reasoning)
     │                                   │
     │                      no tool calls? ──► completed / failed
     │                                   │
     │      prepare: parse JSON, zod-validate, unknown tool → error result
     │      batch:   consecutive read-only calls run in parallel;
     │               writes/commands run alone, in issue order
     │      for each call: loop check → permission engine → approval
     │               (sequential, so prompts never overlap) → execute
     │               with timeout + abort
     │                                   │
     └──── exactly one tool result per call id, in issue order ◄─┘
```

Invariants (all covered by tests):

- Every tool call ID gets exactly one result message. This includes unknown tools, invalid JSON, schema failures, denials, user rejections, timeouts, crashes and cancellations.
- Every turn ends in exactly one terminal state: `completed`, `failed`, `cancelled` or `budget_exceeded`.
- Partial streamed output is never persisted. If a stream breaks mid-response, the UI is told (`stream_reset`), the partial text is discarded, and the request is sent again (at most twice).
- Retries happen only before the first byte arrives. They use exponential backoff with jitter, or `Retry-After` when the server sends it.
- Loop detection compares each call's signature: tool name, canonical arguments, and a "workspace epoch" that advances after every successful write or command. So re-reading a file after editing it is fine, but a fourth identical call with nothing changed in between is refused. After three refusals the turn fails.

## Provider interface

```ts
interface ModelProvider {
  id: string;
  getCapabilities(): ModelCapabilities;
  getModelInfo(model: string): ModelInfo;
  generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
}
```

`ModelEvent` is one of `text_delta`, `reasoning_delta` (a character count only, so reasoning text never reaches UIs), `tool_call_start`, `tool_call_delta`, or a single final `message_complete` carrying the assembled `AssistantMessage`, the finish reason and usage. Providers throw `ProviderError` with a `kind` (`rate_limited`, `authentication`, …), from which `retryable` is derived.

New providers register a factory with `registerProvider(id, (config) => provider)`. Three are registered: `deepseek`, `ollama` and `openai-compatible`. All three use `OpenAICompatibleProvider`, which speaks Chat Completions over fetch + SSE. A *dialect* switch adds DeepSeek's `thinking` / `reasoning_effort` fields and echoes `reasoning_content`; the plain `openai` dialect does neither. Providers can declare `freeOfCharge`, so local inference is costed at $0 instead of "unknown".

### DeepSeek specifics

- The adapter is built on `fetch` plus a spec-conformant SSE parser, not an SDK. This keeps `reasoning_content`, `thinking`, `reasoning_effort` and `prompt_cache_hit_tokens` exactly as documented, and keeps retry decisions inside Sutra.
- Thinking is requested with `thinking: {type}` and `reasoning_effort`. `temperature` is only sent in non-thinking mode, where it has an effect.
- When a request includes `tools`, every earlier assistant message is sent back with its `reasoning_content`. The API requires this and returns 400 otherwise. Without tools it is omitted, since the API ignores it.
- `stream_options.include_usage` is set, and usage is read from the final chunk. `: keep-alive` comments are ignored. An idle watchdog fails a stream that goes silent.

## Context management

`ContextManager` holds the messages after the last compaction boundary. The full raw history always stays in SQLite. Before each inference it estimates the request size with a heuristic, calibrated after every response using the provider's reported `prompt_tokens`. If the estimate exceeds `compactThreshold × limit`, where the limit is the model window capped by `context.maxContextTokens` minus an output reserve, it compacts:

1. It picks a cut point that leaves no tool call dangling. Normally that is before the N most recent user turns. Inside one long turn, it cuts before a recent assistant step.
2. It summarises the dropped part with the model (no tools, thinking disabled) into fixed sections: requirements, task state, decisions, files, errors/verification, pending steps.
3. It appends facts recorded by the harness that the model cannot forget: files modified, recent commands with exit codes, unresolved errors, and the plan.
4. The summary goes into the system prompt. If the remaining messages start with an assistant message, a synthetic user message re-anchors the conversation, so the rebuilt history is protocol-valid.

If the summarisation request fails, a mechanical digest is used instead. The UI is always told when compaction happens.

The system prompt stays stable within a session. The plan reaches the model through `update_plan` results, not by editing the prompt, which keeps DeepSeek's prefix cache warm.

## Persistence

`SessionStore` (`~/.sutra/sutra.db`, mode 600) has these tables: `sessions`, `messages` (full JSON, including reasoning, which is needed for a protocol-correct resume), `tool_invocations`, `checkpoints` (status plus file-state snapshots), `plans`, `compactions` and `usage`. Migrations are versioned with `PRAGMA user_version`. When you resume, Sutra loads the messages after the latest compaction boundary along with its summary, then repairs any dangling tool calls with explicit "interrupted" results. It also restores the plan, the file-state tracker and the usage totals.

## Sandbox

`createSandbox(mode, policy)` probes for a working backend once (by running a trivial sandboxed command) and returns a `SandboxRunner` that wraps a shell command into an argv: `sandbox-exec -p <profile> /bin/sh -c …` on macOS, `bwrap … /bin/sh -c …` on Linux. The runtime passes the runner to shell tools through `ToolContext`, with a per-call `allowNetwork` flag. That flag is set when the permission engine's command assessment says the command needs the network, which means the user approved it as a network command. See [security.md](security.md).

## Context compiler

`ContextCompiler` (`src/context/compiler.ts`, one per session) turns each tool result into the text that enters history, once, at the moment the result is known, so earlier messages are never rewritten and the provider's prefix cache stays valid. It dedupes unchanged re-reads by content hash, sends repeated test runs as deltas (parsed by `src/context/test-report.ts`, falling back to the full output whenever a failure can't be isolated), notes reads made stale by an edit, and keeps the full output of recent calls for `get_output`. `preempt` runs before the permission check and answers an identical test run with nothing changed since. Records are cleared on compaction, and their facts (latest failures, current file hashes) go into the summary. See [token-economy.md](token-economy.md).

## Quality engine

The runtime calls a per-turn `TurnQuality` at four points: `begin` (before the first inference; its text is appended to the request), `observe` (after every tool result), `takeNotes` (before each inference) and `finish` (whenever the model stops calling tools). `finish` either returns a message to continue the loop (the finish gate sending work back) or a `Verification` that is attached to the turn result and saved. The runtime stays independent of the engine's internals. See [quality-engine.md](quality-engine.md).

## Repository index

`RepoIndexService` (one per session) wraps a `RepoIndex`:

1. **Scan.** A synchronous walk honouring `.gitignore` and the default ignore list indexes source files by extension. Unchanged files (same size and mtime) are reused on refresh. Tools refresh at most every 1.5 s, and immediately after a successful edit or command.
2. **Symbols.** Per-language regular expressions (`src/index/symbols.ts`) extract definitions with kind, line, signature, export status and parent class. This is deliberately dependency-free; tree-sitter would be more precise, at the cost of native or WASM grammars.
3. **Graph and rank.** File A links to file B when A uses a *linkable* name that B defines. Linkable means exported (or a distinctive method name), at least 4 characters, and not generic (CamelCase, snake_case or 8+ characters), so words like `type` or `line` don't wire unrelated files together. Personalised PageRank (damping 0.85, 40 iterations) ranks files; focus files get the personalisation mass. Tests, examples, scripts and benchmarks are down-weighted.
4. **Map.** Files in rank order, each with its most-referenced definitions (up to 12) and line numbers, added until the token budget is spent, then a "… N more files" line. With `mapMode: "auto"` (default), `decideFocusMap` (`src/context/focus-map.ts`) decides per request whether to append a map centred on the likely files; with `"always"` the map goes into the system prompt once per session.
5. **Search.** Each file is split into chunks at definition boundaries (at most 80 lines). Terms are identifiers split into lower-case words, lightly stemmed, with stop words removed. The symbol name and path terms are weighted up. BM25 (k1 = 1.2, b = 0.75) is scaled by query coverage. With embeddings configured, the top 50 BM25 hits and the top 50 by cosine similarity are fused with reciprocal-rank fusion (k = 60).

## Audit, replay and benchmarks

- `buildAudit(store, sessionId)` reconstructs a session from SQLite: turns, steps (assistant text paired with the usage row of the request that produced it), tool calls with arguments, results, timings and sandbox, files changed, commands run and compactions. It never includes reasoning content. `renderReplay`, `renderMarkdown` and `renderJson` present it.
- `runBench({ tasks, … })` copies each task's `repo/` into a temp directory, runs one agent turn with the Flow profile, a per-task spend limit and approvals denied, then restores the task's `protected` paths and runs its `verify` command, sandboxed. Pass or fail comes only from that command's exit code. Each run is a normal saved session. See [benchmarks.md](benchmarks.md).

## MCP

`src/mcp/client.ts` connects to the servers in user config before a session starts, discovers their tools, and wraps each one as a normal `Tool` with category `mcp`. The adapter keeps the server's JSON `inputSchema` as the model-visible `parameters` schema, compiles a Zod validator for harness-side argument checks, and formats text, structured content, resources and media into plain text results. The runtime then applies the usual loop detection, timeout, output limit, redaction and persistence.

Connections live for the CLI process, not for one session, so starting a new session or resuming one reuses the same MCP servers. Bench, audit and delegated tasks are deliberately isolated from them. A failed server is reported as a warning and skipped. See [configuration.md](configuration.md#mcp-servers) and [security.md](security.md#mcp-servers).

## Extension points

- **Tools:** implement `Tool<A>` (name, description, version, zod schema, category, `readOnly`, `describe()` for the permission engine, optional `preview()` for approval diffs, `execute()`), then `registry.register(tool)`.
- **Providers:** `registerProvider()`.
- **Delegated tasks:** `runDelegatedTask({ kind, brief, allowTool, profile, maxIterations, maxCostUsd }, env)` runs an isolated runtime with no user approvals. It is not exposed to the model yet.
- **MCP:** `connectMcpServers(config, workspaceRoot)` returns `Tool` adapters, server status and a `close()` handle. Register the adapters on a `ToolRegistry` and pass it to `openSession`.
