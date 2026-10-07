import { describe, expect, it } from "vitest";
import { taskSpent } from "./format";

const startedAt = "2026-10-07T10:00:00.000Z";

describe("taskSpent", () => {
  it("показывает время выполненной задачи и молчит, пока она ждёт человека", () => {
    expect(taskSpent({ status: "done", startedAt, finishedAt: startedAt, activeMs: 90_000 }, false)).toBe(" · 2 min");
    expect(taskSpent({ status: "failed", startedAt, finishedAt: startedAt, activeMs: 45_000 }, false)).toBe(" · 45 sec");
    expect(taskSpent({ status: "done", startedAt, finishedAt: startedAt, activeMs: 3_660_000 }, false)).toBe(" · 1 h 1 min");
    expect(taskSpent({ status: "running", startedAt, finishedAt: null, activeMs: 90_000 }, false)).toBe("");
    expect(taskSpent({ status: "done", startedAt, finishedAt: startedAt, activeMs: 90_000 }, true)).toBe("");
  });

  it("у старой задачи берёт время от начала до конца", () => {
    const finishedAt = "2026-10-07T10:05:00.000Z";
    expect(taskSpent({ status: "canceled", startedAt, finishedAt }, false)).toBe(" · 5 min");
  });
});
