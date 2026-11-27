import { describe, expect, it } from "vitest";
import { LoopDetector } from "../../src/core/agent/loop-detector.js";

/**
 * Unit tests for LoopDetector.
 *
 * The detector tracks call signatures (epoch|name|canonicalArgs).
 * The epoch advances after every write/command so the workspace has changed.
 * Counts and blocked state are reset at the start of each turn.
 */
describe("LoopDetector", () => {
  // ------------------------------------------------------------------ basics

  it("allows a call up to maxRepeats times, then blocks it", () => {
    const d = new LoopDetector(3, 10); // maxRepeats = 3
    expect(d.check("read_file", { path: "a.ts" })).toBe(false); // 1st
    expect(d.check("read_file", { path: "a.ts" })).toBe(false); // 2nd
    expect(d.check("read_file", { path: "a.ts" })).toBe(false); // 3rd — still allowed
    expect(d.check("read_file", { path: "a.ts" })).toBe(true);  // 4th — blocked
  });

  it("treats different tool names as independent signatures", () => {
    const d = new LoopDetector(2, 10);
    d.check("read_file", { path: "a" });
    d.check("read_file", { path: "a" }); // 2nd — still ok
    // A different tool with the same args is a fresh signature
    expect(d.check("list_directory", { path: "a" })).toBe(false);
  });

  it("treats different args as independent signatures", () => {
    const d = new LoopDetector(2, 10);
    d.check("read_file", { path: "a.ts" });
    d.check("read_file", { path: "a.ts" }); // 2nd
    // path "b.ts" is a fresh signature — not counted against path "a.ts"
    expect(d.check("read_file", { path: "b.ts" })).toBe(false);
    expect(d.exhausted).toBe(false);
  });

  // ------------------------------------------------------------------ epoch

  it("advancing the epoch resets the count for the same call", () => {
    const d = new LoopDetector(2, 10);
    d.check("read_file", { path: "a.ts" }); // epoch 0 — 1st
    d.check("read_file", { path: "a.ts" }); // epoch 0 — 2nd
    // A write/command happens: epoch advances
    d.advanceEpoch();
    // Now at epoch 1 — same call is a fresh signature
    expect(d.check("read_file", { path: "a.ts" })).toBe(false);
    expect(d.exhausted).toBe(false);
  });

  it("calls at different epochs are counted independently", () => {
    const d = new LoopDetector(1, 10); // maxRepeats = 1 → block on 2nd
    d.check("read_file", { path: "a.ts" }); // epoch 0 — 1st
    d.advanceEpoch();
    d.check("read_file", { path: "a.ts" }); // epoch 1 — 1st at new epoch
    d.advanceEpoch();
    // epoch 2: 1st call is fresh again, should not be blocked
    expect(d.check("read_file", { path: "a.ts" })).toBe(false);
    expect(d.exhausted).toBe(false);
  });

  // ---------------------------------------------------------------- exhausted

  it("is not exhausted until maxBlocked blocked calls are recorded", () => {
    const d = new LoopDetector(1, 2); // maxBlocked = 2
    // 1st call: allowed; 2nd call: blocked (blocked count → 1)
    d.check("read_file", { path: "a" });
    d.check("read_file", { path: "a" }); // blocked #1
    expect(d.exhausted).toBe(false);    // only 1 of 2 needed
    d.check("read_file", { path: "a" }); // blocked #2
    expect(d.exhausted).toBe(true);
  });

  it("counts blocked calls across different signatures toward exhaustion", () => {
    const d = new LoopDetector(1, 2); // maxBlocked = 2
    // block "a"
    d.check("read_file", { path: "a" });
    d.check("read_file", { path: "a" }); // blocked #1
    expect(d.exhausted).toBe(false);
    // block "b" — different signature, still counts toward exhaustion
    d.check("read_file", { path: "b" });
    d.check("read_file", { path: "b" }); // blocked #2
    expect(d.exhausted).toBe(true);
  });

  // ------------------------------------------------------------------- reset

  it("reset() clears all counts, epoch and blocked state", () => {
    const d = new LoopDetector(1, 1);
    d.check("read_file", { path: "a" });
    d.check("read_file", { path: "a" }); // blocked → exhausted
    expect(d.exhausted).toBe(true);

    d.reset();

    // State is fully cleared
    expect(d.exhausted).toBe(false);
    // The same call is fresh again after reset
    expect(d.check("read_file", { path: "a" })).toBe(false);
  });

  it("reset() also resets the epoch, so old epoch-keyed signatures are gone", () => {
    const d = new LoopDetector(1, 10);
    d.advanceEpoch(); // epoch is now 1
    d.check("read_file", { path: "a" }); // epoch 1 — 1st
    d.reset();        // epoch back to 0
    // Epoch 0 has no history of this call
    expect(d.check("read_file", { path: "a" })).toBe(false);
  });

  // ----------------------------------------------------------------- edge cases

  it("handles null and undefined args without throwing", () => {
    const d = new LoopDetector(2, 10);
    expect(() => d.check("some_tool", null)).not.toThrow();
    expect(() => d.check("some_tool", undefined)).not.toThrow();
  });

  it("handles empty object args and treats them as a stable signature", () => {
    const d = new LoopDetector(2, 10);
    d.check("list_directory", {});
    d.check("list_directory", {}); // 2nd — same empty-object signature
    // 3rd call should be blocked (maxRepeats=2 means block on 3rd)
    expect(d.check("list_directory", {})).toBe(true);
  });
});
