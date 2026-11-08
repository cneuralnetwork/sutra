import type { ToolResult } from "../tools/types.js";
import { parseTestReport, type FailureBlock, type TestReport } from "./test-report.js";

/**
 * The context compiler decides what a tool result costs in the model's
 * context. It runs once per result, as the result enters history, so earlier
 * messages are never rewritten (the provider's prompt cache stays valid).
 *
 *  - A re-read of an unchanged file range (same content hash) becomes a
 *    pointer to the earlier result instead of a second copy.
 *  - A repeated test run is sent as a delta against the previous run of the
 *    same command: unchanged failures by name, new or changed failures with
 *    their exact assertion text, fixed tests, and pass counts. If any failure
 *    can't be isolated, the full output is sent instead: nothing is lossy.
 *  - The exact full output of every call stays available through get_output.
 *
 * Everything it references must still be in the model's context, so the
 * records are cleared whenever history is compacted.
 */

export interface CompileInput {
  callId: string;
  name: string;
  category: string;
  result: ToolResult;
  /** The text the runtime would otherwise send (bounded and redacted). */
  content: string;
  /** The runtime truncated the output before it reached here. */
  truncated: boolean;
  /** Fuller text for get_output when it differs from content (e.g. diagnose_failure's raw runner output). */
  full?: string;
}

interface ReadRecord {
  callId: string;
  hash: string;
  from: number;
  to: number;
}

interface RunRecord {
  callId: string;
  epoch: number;
  exitCode: number | null;
  report: TestReport;
  /** For each failing test: the call whose output shows its current block. */
  shownIn: Map<string, { callId: string; text: string }>;
}

export interface CompilerStats {
  readsDeduped: number;
  testDeltas: number;
  rerunsSkipped: number;
  charsSaved: number;
}

const TEST_TOOLS = new Set(["run_tests", "diagnose_failure"]);
/** Tools whose output is raw runner output, so it can be sent as a delta. */
const DELTA_TOOLS = new Set(["run_tests"]);
const MAX_OUTPUTS = 400;
const MAX_OUTPUT_CHARS_TOTAL = 8_000_000;

export class ContextCompiler {
  private reads = new Map<string, ReadRecord[]>();
  private runs = new Map<string, RunRecord>();
  private outputs = new Map<string, string>();
  private outputChars = 0;
  /** Advances on every change the harness can see (edits, commands, new turns). */
  private epoch = 0;
  readonly stats: CompilerStats = { readsDeduped: 0, testDeltas: 0, rerunsSkipped: 0, charsSaved: 0 };

  constructor(
    private readonly root: string,
    readonly enabled = true,
  ) {}

  /** Something may have changed the workspace. Identical test runs are no longer redundant. */
  advance(): void {
    this.epoch++;
  }

  /** History was compacted: earlier results are gone, so nothing may point at them. */
  reset(): void {
    this.reads.clear();
    this.runs.clear();
    this.advance();
  }

  /** Full output of an earlier call, as recorded (redacted, bounded by the tool). */
  output(callId: string): string | undefined {
    return this.outputs.get(callId);
  }

  private keep(callId: string, text: string): void {
    this.outputs.set(callId, text);
    this.outputChars += text.length;
    while (this.outputs.size > MAX_OUTPUTS || this.outputChars > MAX_OUTPUT_CHARS_TOTAL) {
      const [k, v] = this.outputs.entries().next().value as [string, string];
      this.outputs.delete(k);
      this.outputChars -= v.length;
    }
  }

  /**
   * An identical test run with nothing changed since would repeat the last
   * result exactly. Returns the stub to send instead, or null to run it.
   */
  preempt(name: string, command: string | undefined, force: boolean): ToolResult | null {
    if (!this.enabled || force || !command || !TEST_TOOLS.has(name)) return null;
    const prev = this.runs.get(`${name}\0${command}`);
    if (!prev || prev.epoch !== this.epoch) return null;
    this.stats.rerunsSkipped++;
    const c = prev.report.counts;
    return {
      ok: true,
      output:
        `[Sutra: not re-run — nothing changed since the identical run in call ${prev.callId} (exit ${prev.exitCode}${c ? `; ${c.failed} failed, ${c.passed} passed` : ""}), so its result is still current. ` +
        `Change something first, or pass force: true to run it again (e.g. for a flaky test).]`,
      data: { skipped: true, sameAs: prev.callId },
    };
  }

  compile(inp: CompileInput): string {
    const { result: r } = inp;
    if (r.output && inp.name !== "get_output") this.keep(inp.callId, inp.full ?? inp.content);
    // Any command or MCP tool may change files, so identical test runs after it are not redundant.
    if ((inp.category === "execute" || inp.category === "mcp") && !TEST_TOOLS.has(inp.name)) this.advance();
    if (!this.enabled || !r.ok) return inp.content;
    const data = r.data ?? {};
    if (inp.name === "read_file" && typeof data.hash === "string") return this.compileRead(inp, data);
    if (inp.category === "write" && Array.isArray(data.files)) return this.compileWrite(inp, data.files as string[]);
    if (DELTA_TOOLS.has(inp.name) && typeof data.command === "string" && !data.skipped) return this.compileTest(inp, data);
    return inp.content;
  }

  private compileRead(inp: CompileInput, data: Record<string, unknown>): string {
    const path = String(data.path);
    const rec: ReadRecord = { callId: inp.callId, hash: String(data.hash), from: Number(data.from), to: Number(data.to) };
    const prior = (this.reads.get(path) ?? []).filter((p) => p.hash === rec.hash);
    const cover = prior.find((p) => p.from <= rec.from && p.to >= rec.to);
    if (cover) {
      this.stats.readsDeduped++;
      const stub =
        `[Sutra: ${path} lines ${rec.from}-${rec.to} are unchanged (same content hash ${rec.hash.slice(0, 10)}) since your read in call ${cover.callId}, ` +
        `which showed lines ${cover.from}-${cover.to}; that text is still exact and current, so it isn't repeated here. You may edit the file. ` +
        `get_output {"call_id":"${inp.callId}"} returns this read in full.]`;
      this.stats.charsSaved += Math.max(0, inp.content.length - stub.length);
      return stub;
    }
    // A truncated read can't stand in for a later one.
    if (!inp.truncated) this.reads.set(path, [...prior, rec]);
    return inp.content;
  }

  private compileWrite(inp: CompileInput, files: string[]): string {
    const stale: string[] = [];
    for (const raw of files) {
      const f = raw.replace(/ \((new|delete)\)$/, "");
      const recs = this.reads.get(f);
      if (recs?.length) stale.push(`${f} (${recs.map((r) => r.callId).join(", ")})`);
      this.reads.delete(f);
    }
    this.advance();
    return stale.length ? `${inp.content}\n[Sutra: earlier reads of ${stale.join("; ")} are now out of date; read again before relying on their text elsewhere in the file.]` : inp.content;
  }

  private compileTest(inp: CompileInput, data: Record<string, unknown>): string {
    const command = String(data.command);
    const key = `${inp.name}\0${command}`;
    const exitCode = (data.exitCode as number | null) ?? null;
    const report = parseTestReport(inp.content, this.root);
    const prev = this.runs.get(key);
    const shownIn = new Map<string, { callId: string; text: string }>();
    const record = (sent: string): string => {
      this.runs.set(key, { callId: inp.callId, epoch: this.epoch, exitCode, report, shownIn });
      return sent;
    };
    const full = (): string => {
      for (const f of report.failures) shownIn.set(f.name, { callId: inp.callId, text: f.text });
      return record(inp.content);
    };
    // Lossless only: an unparseable run, a crash, or a truncated log goes out in full.
    if (!prev || inp.truncated || !report.complete || !prev.report.complete || !report.counts || (exitCode !== 0 && report.failures.length === 0)) return full();

    const before = new Map(prev.report.failures.map((f) => [f.name, f]));
    const same: string[] = [];
    const changed: FailureBlock[] = [];
    const added: FailureBlock[] = [];
    for (const f of report.failures) {
      const old = prev.shownIn.get(f.name);
      if (old && old.text === f.text) {
        same.push(f.name);
        shownIn.set(f.name, old);
      } else {
        (before.has(f.name) ? changed : added).push(f);
        shownIn.set(f.name, { callId: inp.callId, text: f.text });
      }
    }
    const now = new Set(report.failures.map((f) => f.name));
    const fixed = prev.report.failures.filter((f) => !now.has(f.name)).map((f) => f.name);

    const header = inp.content.split("\n").filter((l) => !l.startsWith("sandbox:")).slice(0, 3);
    const c = report.counts;
    const pc = prev.report.counts;
    const passNote = pc && pc.passed === c.passed ? `${c.passed} passing (unchanged)` : `${c.passed} passing${pc ? ` (was ${pc.passed})` : ""}`;
    const lines = [
      ...header,
      `Compared with the previous run of this command (call ${prev.callId}): ${c.failed} failed, ${passNote}, ${c.total} total.`,
    ];
    if (same.length) {
      const refs = [...new Set(same.map((n) => shownIn.get(n)!.callId))].join(", ");
      lines.push(`Unchanged failures (${same.length}), identical assertion and stack to call ${refs}: ${same.map((n) => JSON.stringify(n)).join(", ")}`);
    }
    for (const f of changed) lines.push(`Changed failure ${JSON.stringify(f.name)} (exact current output):`, indent(f.text));
    for (const f of added) lines.push(`New failure ${JSON.stringify(f.name)}:`, indent(f.text));
    if (fixed.length) lines.push(`Now passing (failed in call ${prev.callId}): ${fixed.map((n) => JSON.stringify(n)).join(", ")}`);
    if (!same.length && !changed.length && !added.length && !fixed.length && c.failed === 0) lines.push("All tests pass, as before.");
    lines.push(`Full output: get_output {"call_id":"${inp.callId}"}`);
    const delta = lines.join("\n");
    if (delta.length >= inp.content.length) return full();
    this.stats.testDeltas++;
    this.stats.charsSaved += inp.content.length - delta.length;
    return record(delta);
  }

  /** Facts for the compaction summary, so the next context starts from current state. */
  facts(): string[] {
    const out: string[] = [];
    for (const [key, run] of this.runs) {
      const command = key.split("\0")[1];
      const c = run.report.counts;
      out.push(`Latest \`${command}\`: exit ${run.exitCode}${c ? `, ${c.failed} failed / ${c.total}` : ""}${run.report.failures.length ? `; failing: ${run.report.failures.map((f) => f.name).join("; ")}` : ""}`);
      for (const f of run.report.failures.slice(0, 3)) out.push(`  ${f.name}: ${f.text.split("\n").slice(0, 3).join(" / ").slice(0, 300)}`);
    }
    return out;
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
