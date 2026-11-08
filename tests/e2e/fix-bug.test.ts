import { spawn } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/memory/store.js";
import { tempDir } from "../helpers/harness.js";
import { lastToolOutput, startMockDeepSeek, type WireBody } from "../helpers/mock-deepseek-server.js";

const ROOT = join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve("tsx/esm")).href;
const KEY = "sk-e2e-0000000000000000000000";

function runCli(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", TSX, join(ROOT, "src", "index.ts"), ...args], {
      cwd,
      env: { ...process.env, SUTRA_QUALITY: "fast", ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * End-to-end: the real CLI, real DeepSeek provider code (HTTP + SSE), real
 * tools, real permission engine, real SQLite and a real `npm test` run in a
 * sample project with a genuine bug. Only the model's decisions are scripted
 * (by a local server speaking DeepSeek's wire protocol).
 */
describe("e2e: discover, fix, verify, resume", () => {
  let server: Awaited<ReturnType<typeof startMockDeepSeek>>;
  let project: string;
  let home: string;
  const seen: { firstTestRun?: string; secondTestRun?: string } = {};

  beforeAll(async () => {
    project = tempDir("sutra-e2e-project-");
    home = tempDir("sutra-e2e-home-");
    cpSync(join(ROOT, "examples", "session-expiry"), project, { recursive: true });
    server = await startMockDeepSeek(
      [
        () => ({
          reasoning: "I should look at the code and tests first.",
          content: "Inspecting repository.",
          toolCalls: [
            { name: "read_file", args: { path: "src/session.js" } },
            { name: "grep_search", args: { pattern: "expiresAt", path: "src" } },
            { name: "read_file", args: { path: "test/session.test.js" } },
          ],
        }),
        () => ({ reasoning: "Run the tests to see the failure.", toolCalls: [{ name: "run_tests", args: {} }] }),
        (body: WireBody) => {
          seen.firstTestRun = lastToolOutput(body);
          return {
            reasoning: "expiresAt is seconds, now is ms.",
            content: "Found an issue in token expiration handling: seconds are compared with milliseconds.",
            toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: "return session.expiresAt < now;", new_string: "return session.expiresAt * 1000 <= now;" } }],
          };
        },
        () => ({ reasoning: "Verify.", toolCalls: [{ name: "run_tests", args: { filter: "test/**/*.test.js" } }] }),
        (body: WireBody) => {
          seen.secondTestRun = lastToolOutput(body);
          const passed = /exit code 0/.test(seen.secondTestRun);
          return { reasoning: "Report.", content: passed ? "Fixed `isExpired` in src/session.js; all tests pass." : "Tests still fail." };
        },
        // Resumed session
        () => ({ reasoning: "Answer from history.", content: "I changed isExpired to convert seconds to milliseconds." }),
      ],
      KEY,
    );
  });

  afterAll(async () => {
    await server?.close();
  });

  it("fixes the bug through the CLI and verifies it with the real test suite", async () => {
    const env = { SUTRA_HOME: home, DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url, DEEPSEEK_MODEL: "deepseek-flash" };
    const r = await runCli(["-p", "The session tests fail. Find and fix the bug.", "--profile", "flow"], project, env);
    if (r.code !== 0) console.error(r.stderr);
    expect(r.code).toBe(0);

    // Real failing test output was observed by the model before the fix...
    expect(seen.firstTestRun).toMatch(/exit code 1/);
    expect(seen.firstTestRun).toMatch(/fail 2/);
    // ...and a real passing run after it.
    expect(seen.secondTestRun).toMatch(/exit code 0/);
    expect(seen.secondTestRun).toMatch(/pass 4/);

    // The change is on disk.
    expect(readFileSync(join(project, "src", "session.js"), "utf8")).toContain("return session.expiresAt * 1000 <= now;");

    // CLI output: answer on stdout, activity + summary on stderr.
    expect(r.stdout).toContain("all tests pass");
    expect(r.stderr).toMatch(/read_file\s+Read src\/session.js/);
    expect(r.stderr).toMatch(/edit_file\s+Edit src\/session.js/);
    expect(r.stderr).toContain("Files changed   src/session.js");
    expect(r.stderr).toContain("Tests           passed (npm test -- 'test/**/*.test.js')");

    // Protocol: the first request is a proper thinking + tools request; the three
    // read-only calls were answered in order with one result each.
    const first = server.requests[0]!;
    expect(first.thinking).toEqual({ type: "enabled" });
    expect(first.stream).toBe(true);
    const second = server.requests[1]!;
    const tools = second.messages.filter((m) => m.role === "tool");
    const calls = second.messages.find((m) => m.role === "assistant")!.tool_calls!;
    expect(tools.map((t) => t.tool_call_id)).toEqual(calls.map((c) => c.id));
    expect(second.messages.find((m) => m.role === "assistant")!.reasoning_content).toBe("I should look at the code and tests first.");

    // Usage and cost were recorded from the provider's reported usage.
    const store = new SessionStore(join(home, "sutra.db"));
    const session = store.listSessions()[0]!;
    const totals = store.usageTotals(session.id);
    expect(totals.requests).toBe(5);
    expect(totals.inputTokens).toBe(5 * 1500);
    expect(totals.cachedInputTokens).toBe(5 * 1000);
    expect(totals.reasoningTokens).toBe(5 * 40);
    expect(totals.toolCalls).toBe(6);
    expect(totals.costUsd).toBeGreaterThan(0);
    expect(session.status).toBe("completed");
    store.close();
  }, 60_000);

  it("resumes the session with its full history", async () => {
    const env = { SUTRA_HOME: home, DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: server.url };
    const r = await runCli(["--resume", "-p", "What did you change?"], project, env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("seconds to milliseconds");
    const req = server.requests.at(-1)!;
    const users = req.messages.filter((m) => m.role === "user").map((m) => m.content);
    // The first request was ambiguous, so it carried a focused map; the follow-up names no code and gets none.
    expect(users[0]).toMatch(/^The session tests fail\. Find and fix the bug\.\n\n\[Sutra repository map — centred on /);
    expect(users[1]).toBe("What did you change?");
    expect(users).toHaveLength(2);
    // Every earlier assistant message still carries reasoning_content (else the mock returns 400).
    expect(req.messages.filter((m) => m.role === "assistant").every((m) => typeof m.reasoning_content === "string")).toBe(true);
  }, 60_000);

  it("in confirm profile without a terminal, edits are denied, not silently applied", async () => {
    const p2 = tempDir("sutra-e2e-confirm-");
    cpSync(join(ROOT, "examples", "session-expiry"), p2, { recursive: true });
    const s = await startMockDeepSeek(
      [
        () => ({ reasoning: "r", toolCalls: [{ name: "read_file", args: { path: "src/session.js" } }] }),
        () => ({ reasoning: "r", toolCalls: [{ name: "edit_file", args: { path: "src/session.js", old_string: "expiresAt < now", new_string: "expiresAt * 1000 <= now" } }] }),
        (body) => ({ reasoning: "r", content: lastToolOutput(body).includes("user_rejected") ? "The edit was declined." : "edited" }),
      ],
      KEY,
    );
    const r = await runCli(["-p", "fix it"], p2, { SUTRA_HOME: tempDir(), DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: s.url });
    await s.close();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("The edit was declined.");
    expect(readFileSync(join(p2, "src", "session.js"), "utf8")).toContain("return session.expiresAt < now;");
  }, 60_000);

  it("reports authentication failures clearly", async () => {
    const r = await runCli(["-p", "hi"], project, { SUTRA_HOME: tempDir(), DEEPSEEK_API_KEY: "sk-wrong-000000000000", DEEPSEEK_BASE_URL: server.url });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/failed — DeepSeek API 401/);
  }, 60_000);
});
