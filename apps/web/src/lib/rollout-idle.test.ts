import { describe, expect, it } from "vitest";
import type { Run } from "@swarm/contracts";
import { rolloutIdle } from "./rollout-idle";

function run(status: Run["status"]): Run {
  return {
    id: `run_${status}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    status,
    trigger: "chat",
    title: "t",
    summary: "",
    threadId: null,
  };
}

describe("rolloutIdle", () => {
  it("is idle when every task is finished and the browser is free", () => {
    expect(rolloutIdle({ busyInBrowser: false, runs: [run("done"), run("failed"), run("escalated")] })).toBe(true);
  });

  it("is busy while a task runs or waits in the queue", () => {
    expect(rolloutIdle({ busyInBrowser: false, runs: [run("done"), run("running")] })).toBe(false);
    expect(rolloutIdle({ busyInBrowser: false, runs: [run("queued")] })).toBe(false);
  });

  it("does not interrupt a browser that waits for an emailed code", () => {
    expect(rolloutIdle({ busyInBrowser: true, runs: [] })).toBe(false);
  });

  it("treats a task waiting for approval as idle: the question survives a restart", () => {
    expect(rolloutIdle({ busyInBrowser: false, runs: [run("waiting_approval")] })).toBe(true);
  });
});
