import { describe, expect, it } from "vitest";
import { QUIET_AFTER_EMPTY, QUIET_MS, nextQuiet } from "../../src/tasks/tick-quiet";

describe("nextQuiet", () => {
  const now = Date.parse("2026-10-07T19:00:00.000Z");

  it("waits for a second empty survey before going quiet", () => {
    const first = nextQuiet({ streak: 0 }, "empty", now);
    expect(first.state.streak).toBe(1);
    expect(first.quietUntil).toBeNull();
    const second = nextQuiet(first.state, "empty", now);
    expect(second.state.streak).toBe(QUIET_AFTER_EMPTY);
    expect(second.quietUntil).toBe(new Date(now + QUIET_MS).toISOString());
  });

  it("clears the streak when the survey finds work", () => {
    const next = nextQuiet({ streak: 4 }, "work", now);
    expect(next).toEqual({ state: { streak: 0 }, quietUntil: null });
  });
});
