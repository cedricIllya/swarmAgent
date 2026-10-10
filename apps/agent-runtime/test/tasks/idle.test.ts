import { describe, expect, it } from "vitest";
import type { Run } from "@swarm/contracts";
import type { AgentRuntime } from "../../src/runtime";
import { canSuspendNow, IDLE_MS, machineIsIdle, noteActivity } from "../../src/tasks/idle";
import { tick, tickBusy } from "../../src/tasks/cron";

function runtime(runs: Run[] = [], takeDeferredEmails?: () => Promise<unknown[]>): AgentRuntime {
  return {
    busyInBrowser: false,
    skyvern: null,
    browser: { waitingForCode: false, sessions: new Map() },
    store: {
      listRuns: async () => runs,
      takeDeferredEmails: takeDeferredEmails ?? (async () => []),
      readServices: async () => null,
    },
  } as unknown as AgentRuntime;
}

function run(status: Run["status"]): Run {
  return {
    id: "run_1",
    title: "Задача",
    threadId: null,
    status,
    trigger: "chat",
    startedAt: "2026-10-10T14:13:40.000Z",
    finishedAt: null,
    summary: "",
  };
}

describe("canSuspendNow", () => {
  it("спит только после пяти минут без задач", async () => {
    const rt = runtime();
    noteActivity();
    const at = Date.now();
    expect(await canSuspendNow(rt, at + IDLE_MS - 1_000)).toBe(false);
    expect(await canSuspendNow(rt, at + IDLE_MS + 1_000)).toBe(true);
  });

  it("новая работа начинает пять минут заново", async () => {
    const rt = runtime();
    noteActivity();
    noteActivity();
    expect(await canSuspendNow(rt, Date.now() + IDLE_MS - 1_000)).toBe(false);
  });

  it("не усыпляет машину с задачей, которая ещё идёт", async () => {
    noteActivity();
    const later = Date.now() + IDLE_MS + 1_000;
    expect(await canSuspendNow(runtime([run("running")]), later)).toBe(false);
    expect(await canSuspendNow(runtime([run("queued")]), later)).toBe(false);
    expect(await machineIsIdle(runtime([run("done")]))).toBe(true);
  });

  it("ожидание одобрения само по себе машину не держит", async () => {
    noteActivity();
    expect(await canSuspendNow(runtime([run("waiting_approval")]), Date.now() + IDLE_MS + 1_000)).toBe(true);
  });

  it("не усыпляет машину, пока тик не вернулся и задачи ещё нет", async () => {
    noteActivity();
    const at = Date.now();
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    const rt = runtime([], () => gate);
    const pending = tick(rt);
    expect(tickBusy()).toBe(true);
    expect(await machineIsIdle(rt)).toBe(false);
    expect(await canSuspendNow(rt, at + IDLE_MS + 60_000)).toBe(false);
    release([]);
    await pending;
    expect(tickBusy()).toBe(false);
    expect(await canSuspendNow(rt, at + IDLE_MS - 1_000)).toBe(false);
    expect(await canSuspendNow(rt, at + IDLE_MS + 60_000)).toBe(true);
  });
});
