import { describe, expect, it, vi } from "vitest";
import type { Run, RunStep, ServicesSnapshot } from "@swarm/contracts";
import { acceptFoundTask, tick } from "../../src/tasks/cron";
import { pageDigest } from "../../src/tasks/watch-page";
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

function runtime(opts?: {
  reply?: string;
  open?: Run[];
  openSteps?: Record<string, RunStep[]>;
  report?: boolean;
  services?: ServicesSnapshot;
  browser?: unknown;
}) {
  const runs = new Map<string, Run>();
  const steps = new Map<string, RunStep[]>();
  const order: string[] = [];
  let n = 0;
  for (const run of opts?.open ?? []) runs.set(run.id, run);
  for (const [id, list] of Object.entries(opts?.openSteps ?? {})) steps.set(id, list);
  const think = vi.fn(async (run: Run, _prompt: string) => {
    order.push(`think:${run.title}`);
    if (opts?.report && run.title === "Плановая проверка сервисов") {
      await acceptFoundTask(rt, run.id, { service: "linear", title: "Починить баг", detail: "LIN-12, назначена на меня" });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      order.push("survey-still-open");
    }
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
    browser: opts?.browser ?? { waitingForCode: false },
    isCanceled: async (id: string) => (await rt.store.getRun(id))?.status === "canceled",
    store: {
      takeDeferredEmails: async () => [],
      readServices: async () => opts?.services ?? services,
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
  it("starts a reported task while the check is still looking", async () => {
    const { rt, runs, order, think } = runtime({ reply: "пусто", report: true });
    await tick(rt);
    const check = [...runs.values()].find((r) => r.title === "Плановая проверка сервисов");
    const task = [...runs.values()].find((r) => r.title === "linear: Починить баг");
    expect(check?.summary).toBe("В работе: linear: Починить баг");
    expect(task?.status).toBe("done");
    expect(task?.summary).toBe("Сделал задачу в Linear");
    expect(order.indexOf("think:linear: Починить баг")).toBeGreaterThan(-1);
    expect(order.indexOf("think:linear: Починить баг")).toBeLessThan(order.indexOf("survey-still-open"));
    expect(order.indexOf("finish:linear: Починить баг:done")).toBeLessThan(order.indexOf("survey-still-open"));
    expect(think.mock.calls[1]?.[0]).toMatchObject({ id: task?.id });
    expect(String(think.mock.calls[1]?.[1])).toMatch(/Выполни её/);
  });

  it("starts a task from the final list without waiting for another tick", async () => {
    const { rt, runs, think } = runtime();
    const result = await tick(rt);
    expect(result).toEqual({ deferred: 0, checkedServices: true, quiet: "clear", quietUntil: null });
    const check = [...runs.values()].find((r) => r.title === "Плановая проверка сервисов");
    const task = [...runs.values()].find((r) => r.title === "linear: Починить баг");
    expect(check?.status).toBe("done");
    expect(check?.summary).toBe("В работе: linear: Починить баг");
    expect(task?.status).toBe("done");
    expect(task?.summary).toBe("Сделал задачу в Linear");
    expect(think).toHaveBeenCalledTimes(2);
    expect(String(think.mock.calls[0]?.[1])).toMatch(/\/tasks\/found/);
    expect(String(think.mock.calls[1]?.[1])).toMatch(/Починить баг/);
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
      "Уже в работе: linear: Починить баг",
    );
    expect(think).toHaveBeenCalledTimes(1);
  });

  it("does not start a task the mail run already took by ticket", async () => {
    const open = {
      id: "run_mail",
      title: "Назначили задачу",
      threadId: "<m@linear.app>",
      status: "running",
      trigger: "email",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      summary: "",
    } as Run;
    const { rt, runs, think } = runtime({
      open: [open],
      openSteps: {
        run_mail: [{ at: "2026-01-01T00:00:00.000Z", kind: "email", text: "notification от Linear, карточка LIN-12" }],
      },
    });
    await tick(rt);
    expect([...runs.values()].filter((r) => r.trigger === "cron" && r.title !== "Плановая проверка сервисов")).toHaveLength(0);
    expect([...runs.values()].find((r) => r.title === "Плановая проверка сервисов")?.summary).toBe(
      "Уже в работе: linear: Починить баг",
    );
    expect(think).toHaveBeenCalledTimes(1);
  });

  it("does not start a found task while a mail sweep of that service is still open", async () => {
    const open = {
      id: "run_mail",
      title: "Новые задачи",
      threadId: "<m@linear.app>",
      status: "running",
      trigger: "email",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      summary: "",
    } as Run;
    const { rt, runs, think } = runtime({
      open: [open],
      openSteps: {
        run_mail: [
          {
            at: "2026-01-01T00:00:00.000Z",
            kind: "email",
            text: "notification от Linear",
            data: { service: "Linear", broad: true },
          },
        ],
      },
    });
    await tick(rt);
    expect([...runs.values()].filter((r) => r.title === "linear: Починить баг")).toHaveLength(0);
    expect([...runs.values()].find((r) => r.title === "Плановая проверка сервисов")?.summary).toBe(
      "Уже в работе: linear: Починить баг",
    );
    expect(think).toHaveBeenCalledTimes(1);
  });

  it("reads a saved tasks page without asking the model to search", async () => {
    const cards = "https://trello.com/u/me/cards";
    let url = cards;
    const extract = vi.fn(async () => ({
      tasks: [{ title: "Починить баг", detail: "сделать", key: "https://trello.com/c/abc" }],
    }));
    const act = vi.fn();
    const session = {
      id: "ses",
      serviceSlug: "trello",
      goto: async (next: string) => {
        url = next;
      },
      currentUrl: async () => url,
      act,
      extract,
      read: async () => ({ url, text: "мои карточки ".repeat(40) }),
    };
    const open = vi.fn(async () => session);
    const snap = {
      generatedAt: "t",
      recipes: [
        {
          slug: "trello",
          name: "Trello",
          kind: "browser" as const,
          domains: ["trello.com"],
          notes: "Как работать: карточки на доске.",
          discoveredBy: null,
          watchesTasks: true,
          browser: { loginUrl: "https://trello.com/login", appUrl: "https://trello.com/" },
        },
      ],
      credentials: [{ slug: "trello", kind: "browser" as const, tasksUrl: cards, accountEmail: "a@b.c", password: "pw" }],
    };
    const { rt, runs, think } = runtime({
      services: snap,
      browser: { waitingForCode: false, open, close: async () => undefined, sessions: new Map() },
    });
    await tick(rt);
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ url: cards, serviceSlug: "trello" }));
    expect(act).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(think).toHaveBeenCalledTimes(1);
    expect(String(think.mock.calls[0]?.[1])).toMatch(/Починить баг/);
    expect(String(think.mock.calls[0]?.[1])).not.toMatch(/\/tasks\/found/);
    expect([...runs.values()].find((r) => r.title === "Плановая проверка сервисов")?.summary).toBe(
      "В работе: trello: Починить баг",
    );
  });

  it("does not ask the model to read an unchanged API list", async () => {
    const body = '{"issues":[]}';
    const previous = globalThis.fetch;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    globalThis.fetch = fetchImpl as typeof fetch;
    const snap = {
      generatedAt: "t",
      recipes: [
        {
          slug: "linear",
          name: "Linear",
          kind: "api" as const,
          domains: ["linear.app"],
          notes: "",
          discoveredBy: null,
          watchesTasks: true,
          api: { baseUrl: "https://api.linear.app", auth: "bearer" as const, authHeader: "Authorization" },
        },
      ],
      credentials: [
        {
          slug: "linear",
          kind: "api" as const,
          token: "lin",
          tasksDigest: pageDigest(body),
          tasksCall: { kind: "api" as const, method: "GET" as const, url: "https://api.linear.app/issues" },
        },
      ],
    };
    try {
      const { rt, runs, think } = runtime({ services: snap });
      await tick(rt);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(think).not.toHaveBeenCalled();
      expect([...runs.values()].find((r) => r.title === "Плановая проверка сервисов")?.summary).toBe("пусто");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
