import { describe, expect, it } from "vitest";
import type { Run, RunStep } from "@swarm/contracts";
import { bindWork, holdWork } from "../../src/tasks/work-claim";
import type { AgentRuntime } from "../../src/runtime";

function runtime() {
  const runs = new Map<string, Run>();
  const steps = new Map<string, RunStep[]>();
  const rt = {
    store: {
      listRuns: async () => [...runs.values()],
      getRun: async (id: string) => runs.get(id) ?? null,
      listSteps: async (id: string) => steps.get(id) ?? [],
    },
  } as unknown as AgentRuntime;
  return { rt, runs, steps };
}

function run(id: string, title: string, status: Run["status"] = "running"): Run {
  return {
    id,
    title,
    threadId: null,
    status,
    trigger: "email",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    summary: "",
  };
}

describe("holdWork", () => {
  it("blocks the same ticket under a different title and allows the next one", async () => {
    const { rt, runs, steps } = runtime();
    runs.set("run_mail", run("run_mail", "Назначили задачу"));
    steps.set("run_mail", [{ at: "t", kind: "email", text: "карточка LIN-12" }]);

    const same = await holdWork(rt, {
      service: "linear",
      title: "linear: Починить баг",
      texts: ["LIN-12, назначена на меня"],
      broad: false,
    });
    const other = await holdWork(rt, {
      service: "linear",
      title: "linear: Написать отчёт",
      texts: ["LIN-13"],
      broad: false,
    });

    expect(same).toMatchObject({ ok: false, runId: "run_mail", title: "Назначили задачу" });
    expect(other.ok).toBe(true);
  });

  it("keeps a mail sweep from opening the same service again, then lets it go after the run closes", async () => {
    const { rt, runs } = runtime();
    const first = await holdWork(rt, {
      service: "Linear",
      title: "Новые задачи",
      texts: ["в сервисе появились задачи"],
      broad: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const mail = run("run_mail", "Новые задачи");
    runs.set(mail.id, mail);
    bindWork(rt, first.id, mail.id, mail.title);

    const whileOpen = await holdWork(rt, {
      service: "linear",
      title: "linear: Починить баг",
      texts: ["сделать форму"],
      broad: false,
    });
    expect(whileOpen).toMatchObject({ ok: false, runId: "run_mail" });

    mail.status = "done";
    const after = await holdWork(rt, {
      service: "linear",
      title: "linear: Починить баг",
      texts: ["сделать форму"],
      broad: false,
    });
    expect(after.ok).toBe(true);
  });

  it("does not treat the same words in another service as one task", async () => {
    const { rt, runs } = runtime();
    const notion = run("run_notion", "notion: Починить баг");
    runs.set(notion.id, notion);
    const linear = await holdWork(rt, {
      service: "linear",
      title: "linear: Починить баг",
      texts: ["другая доска"],
      broad: false,
    });
    expect(linear.ok).toBe(true);
  });
});
