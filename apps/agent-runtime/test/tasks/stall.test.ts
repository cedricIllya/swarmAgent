import { describe, expect, it, vi } from "vitest";
import type { Run, RunStep } from "@swarm/contracts";
import { STALL_MS, closeStalledRuns } from "../../src/tasks/stall";
import type { AgentRuntime } from "../../src/runtime";

function runtime(run: Run | Run[], steps: RunStep[] = [], browserRunId: string | null = null, hermesBusy = false) {
  const runs = new Map<string, Run>((Array.isArray(run) ? run : [run]).map((r) => [r.id, r]));
  const finishRun = vi.fn(async (current: Run, status: Run["status"], summary: string) => {
    current.status = status;
    current.summary = summary;
    runs.set(current.id, current);
  });
  const rt = {
    hermes: { busy: hermesBusy },
    browser: {
      sessions: new Map(
        browserRunId
          ? [[
              "s1",
              { meta: { runId: browserRunId, finishedAt: null } },
            ]]
          : [],
      ),
    },
    abortRun: vi.fn(),
    step: vi.fn(async (id: string, kind: RunStep["kind"], text: string) => {
      steps.push({ at: new Date().toISOString(), kind, text });
    }),
    finishRun,
    store: {
      listRuns: async () => [...runs.values()],
      listSteps: async () => steps,
    },
  } as unknown as AgentRuntime;
  return { rt, runs, finishRun };
}

function task(status: Run["status"], startedAt: string, id = "run_1"): Run {
  return {
    id,
    title: "Зависшая",
    threadId: null,
    status,
    trigger: "chat",
    startedAt,
    finishedAt: null,
    summary: "",
  };
}

describe("closeStalledRuns", () => {
  const now = Date.parse("2026-10-07T19:00:00.000Z");

  it("fails a run that has not moved for ten minutes", async () => {
    const { rt, runs, finishRun } = runtime(task("running", new Date(now - STALL_MS - 1_000).toISOString()));
    expect(await closeStalledRuns(rt, now)).toBe(1);
    expect(runs.get("run_1")?.status).toBe("failed");
    expect(finishRun).toHaveBeenCalledOnce();
  });

  it("leaves a fresh run and a run whose browser is still open", async () => {
    const fresh = runtime(task("running", new Date(now - 60_000).toISOString()));
    expect(await closeStalledRuns(fresh.rt, now)).toBe(0);
    const browsing = runtime(task("queued", new Date(now - STALL_MS - 5_000).toISOString()), [], "run_1");
    expect(await closeStalledRuns(browsing.rt, now)).toBe(0);
    expect(browsing.runs.get("run_1")?.status).toBe("queued");
  });

  it("не закрывает задачи, пока идёт ход Hermes", async () => {
    const { rt, runs } = runtime(task("running", new Date(now - STALL_MS * 2).toISOString()), [], null, true);
    expect(await closeStalledRuns(rt, now)).toBe(0);
    expect(runs.get("run_1")?.status).toBe("running");
  });

  it("задача в очереди ждёт, пока работает другая", async () => {
    const old = new Date(now - STALL_MS * 2).toISOString();
    const { rt, runs } = runtime([task("queued", old, "run_q"), task("running", new Date(now - 60_000).toISOString(), "run_w")], [
      { at: new Date(now - 60_000).toISOString(), kind: "note", text: "идёт" },
    ]);
    expect(await closeStalledRuns(rt, now)).toBe(0);
    expect(runs.get("run_q")?.status).toBe("queued");
  });

  it("does not close a task that is waiting for a person", async () => {
    const { rt, runs } = runtime(task("waiting_approval", new Date(now - STALL_MS * 3).toISOString()));
    expect(await closeStalledRuns(rt, now)).toBe(0);
    expect(runs.get("run_1")?.status).toBe("waiting_approval");
  });
});
