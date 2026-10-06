import { describe, expect, it, vi } from "vitest";
import type { Run, RunStep } from "@swarm/contracts";
import { tick } from "../../src/tasks/cron";
import type { AgentRuntime } from "../../src/runtime";

const services = {
  generatedAt: "t",
  recipes: [
    {
      slug: "linear",
      name: "Linear",
      kind: "mcp" as const,
      domains: ["linear.app"],
      notes: "",
      discoveredBy: null,
      watchesTasks: true,
    },
  ],
  credentials: [{ slug: "linear", kind: "mcp" as const, token: "lin" }],
};

function runtime(opts?: { reply?: string; open?: Run[] }) {
  const runs = new Map<string, Run>();
  const steps = new Map<string, RunStep[]>();
  const order: string[] = [];
  let n = 0;
  for (const run of opts?.open ?? []) runs.set(run.id, run);
  const think = vi.fn(async (run: Run, _prompt: string) => {
    order.push(`think:${run.title}`);
    const at = new Date().toISOString();
    const list = steps.get(run.id) ?? [];
    list.push({
      at,
      kind: run.title === "Плановая проверка сервисов" ? "mcp" : "api",
      text: "вызов сервиса",
    });
    steps.set(run.id, list);
    const text =
      run.title === "Плановая проверка сервисов"
        ? (opts?.reply ??
          '{"tasks":[{"service":"linear","title":"Починить баг","detail":"LIN-12, назначена на меня"}]}')
        : "Сделал задачу в Linear";
    return { text, usedFallback: false, startedAt: at };
  });
  const rt = {
    browser: { waitingForCode: false },
    isCanceled: async (id: string) => (await rt.store.getRun(id))?.status === "canceled",
    store: {
      takeDeferredEmails: async () => [],
      readServices: async () => services,
      listRuns: async () => [...runs.values()],
      getRun: async (id: string) => runs.get(id) ?? null,
      listSteps: async (id: string) => steps.get(id) ?? [],
      saveRun: async (run: Run) => {
        runs.set(run.id, run);
      },
    },
    createRun: async (trigger: Run["trigger"], title: string, threadId: string | null, status: Run["status"] = "running") => {
      const run = {
        id: `run_${++n}`,
        title,
        threadId,
        status,
        trigger,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: "",
      } as Run;
      runs.set(run.id, run);
      order.push(`create:${title}:${status}`);
      return run;
    },
    step: vi.fn(async (id: string, kind: RunStep["kind"], text: string) => {
      const list = steps.get(id) ?? [];
      list.push({ at: new Date().toISOString(), kind, text });
      steps.set(id, list);
    }),
    finishRun: async (run: Run, status: Run["status"], summary: string) => {
      const current = runs.get(run.id) ?? run;
      current.status = status;
      current.summary = summary;
      runs.set(current.id, current);
      order.push(`finish:${current.title}:${status}`);
    },
    think,
  } as unknown as AgentRuntime;
  return { rt, runs, order, think };
}

describe("tick", () => {
  it("queues a found task and does it after the check is closed", async () => {
    const { rt, runs, order, think } = runtime();
    const result = await tick(rt);
    expect(result).toEqual({ deferred: 0, checkedServices: true });
    const check = [...runs.values()].find((r) => r.title === "Плановая проверка сервисов");
    const task = [...runs.values()].find((r) => r.title === "linear: Починить баг");
    expect(check?.status).toBe("done");
    expect(check?.summary).toBe("В очередь: linear: Починить баг");
    expect(task?.status).toBe("done");
    expect(task?.summary).toBe("Сделал задачу в Linear");
    expect(order).toEqual([
      "create:Плановая проверка сервисов:running",
      "think:Плановая проверка сервисов",
      "create:linear: Починить баг:queued",
      "finish:Плановая проверка сервисов:done",
      "think:linear: Починить баг",
      "finish:linear: Починить баг:done",
    ]);
    expect(think).toHaveBeenCalledTimes(2);
    expect(String(think.mock.calls[0]?.[1])).toMatch(/Не выполняй/);
    expect(String(think.mock.calls[1]?.[1])).toMatch(/Починить баг/);
    expect(String(think.mock.calls[1]?.[1])).toMatch(/Выполни её/);
    expect(think.mock.calls[1]?.[0]).toMatchObject({ id: task?.id });
  });

  it("closes an empty check without a second task", async () => {
    const { rt, runs, think } = runtime({ reply: "пусто" });
    await tick(rt);
    expect([...runs.values()].map((r) => r.title)).toEqual(["Плановая проверка сервисов"]);
    expect([...runs.values()][0]?.summary).toBe("пусто");
    expect(think).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue a task that is already running", async () => {
    const open = {
      id: "run_open",
      title: "linear: Починить баг",
      threadId: null,
      status: "running",
      trigger: "cron",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      summary: "",
    } as Run;
    const { rt, runs, think } = runtime({ open: [open] });
    await tick(rt);
    expect([...runs.values()].filter((r) => r.title === "linear: Починить баг")).toHaveLength(1);
    expect([...runs.values()].find((r) => r.title === "Плановая проверка сервисов")?.summary).toBe(
      "Уже в очереди: linear: Починить баг",
    );
    expect(think).toHaveBeenCalledTimes(1);
  });
});
