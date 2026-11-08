import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlanStore } from "../../src/core/planning/plan.js";
import { RepoIndexService } from "../../src/index/service.js";
import { Workspace } from "../../src/permissions/paths.js";
import { SecretRedactor } from "../../src/permissions/sensitive.js";
import { FileStateTracker } from "../../src/tools/file-state.js";
import { definitionEnd } from "../../src/tools/index/inspect-tools.js";
import { createDefaultRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";
import { tempDir, writeFiles } from "../helpers/harness.js";

const reg = createDefaultRegistry();

const FILES = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test test/**/*.test.js" } }),
  "src/session.js": `export function isExpired(session, now = Date.now()) {
  return session.expiresAt < now;
}

export async function ensureFresh(session, refresh, now = Date.now()) {
  if (isExpired(session, now)) return refresh(session.refreshToken);
  return session;
}
`,
  "test/session.test.js": `import test from "node:test";
import assert from "node:assert/strict";
import { isExpired } from "../src/session.js";

test("not expired in an hour", () => {
  assert.equal(isExpired({ expiresAt: 10 }, 5), false);
});

test("expired after", () => {
  assert.equal(isExpired({ expiresAt: 1 }, 5), true);
});
`,
};

function setup(files: Record<string, string> = FILES): { root: string; c: ToolContext } {
  const root = tempDir();
  writeFiles(root, files);
  const c: ToolContext = {
    workspace: new Workspace(root),
    fileState: new FileStateTracker(),
    plan: new PlanStore(),
    redactor: new SecretRedactor(),
    signal: new AbortController().signal,
    sessionId: "s",
    toolCallId: "c7",
    settings: { commandTimeoutMs: 60_000, maxOutputChars: 30_000, retainFullLogs: false, scrubEnv: true, logDir: join(root, ".logs") },
    repoIndex: new RepoIndexService(root, { maxFiles: 100, cacheDir: tempDir() }),
  };
  return { root, c };
}

const run = async (name: string, args: unknown, c: ToolContext) => {
  const t = reg.get(name)!;
  return t.execute(t.schema.parse(args), c);
};

describe("definitionEnd", () => {
  it("follows braces, multi-line signatures and Python indentation", () => {
    const ts = ["function f(", "  a: number,", "): number {", "  if (a) { return '}'; }", "  return a;", "}", "const x = 1;"];
    expect(definitionEnd(ts, 0, 80, "a.ts")).toEqual({ end: 5, complete: true });
    const py = ["def f(a):", "    if a:", "        return 1", "", "    return 2", "", "def g():", "    pass"];
    expect(definitionEnd(py, 0, 80, "a.py")).toEqual({ end: 4, complete: true });
    expect(definitionEnd(ts, 0, 3, "a.ts")).toEqual({ end: 2, complete: false });
    expect(definitionEnd(["type A = string;", "type B = number;"], 0, 80, "a.ts")).toEqual({ end: 0, complete: true });
  });
});

describe("inspect_symbol", () => {
  it("returns the exact body, callers with their enclosing function, and tests, and allows editing", async () => {
    const { c } = setup();
    const r = await run("inspect_symbol", { name: "isExpired" }, c);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("## function isExpired — src/session.js:1-3");
    expect(r.output).toContain("2\t  return session.expiresAt < now;");
    expect(r.output).not.toContain("ensureFresh(session, refresh"); // the next definition isn't part of the body
    expect(r.output).toMatch(/src\/session\.js:6 {2}in ensureFresh/);
    expect(r.output).toMatch(/test\/session\.test\.js:6 {2}/);
    expect(r.data).not.toHaveProperty("files"); // never mistaken for a change
    const e = await run("edit_file", { path: "src/session.js", old_string: "session.expiresAt < now", new_string: "session.expiresAt * 1000 <= now" }, c);
    expect(e.ok).toBe(true);
  });

  it("reports a missing symbol", async () => {
    const { c } = setup();
    expect((await run("inspect_symbol", { name: "nope" }, c)).error?.code).toBe("not_found");
  });
});

describe("diagnose_failure", () => {
  it("returns each failure with its assertion and the code it exercises", async () => {
    const { c } = setup({ ...FILES, "src/session.js": FILES["src/session.js"].replace("session.expiresAt < now", "session.expiresAt > now") });
    const r = await run("diagnose_failure", {}, c);
    expect(r.data?.exitCode).toBe(1);
    expect(r.output).toContain("2 failed, 0 passed, 2 total");
    expect(r.output).toContain("### not expired in an hour");
    expect(r.output).toContain("true !== false");
    expect(r.output).toMatch(/Assertion: test\/session\.test\.js:6/);
    expect(r.output).toMatch(/>\s*6\t {2}assert\.equal\(isExpired/);
    expect(r.output).toContain("src/session.js:1  export function isExpired");
    expect(r.output).toContain('get_output {"call_id":"c7"}');
    expect(typeof r.data?.rawOutput).toBe("string");
  });

  it("says so when everything passes", async () => {
    const { c } = setup();
    const r = await run("diagnose_failure", {}, c);
    expect(r.output).toContain("All tests pass");
  });
});
