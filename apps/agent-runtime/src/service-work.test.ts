import { describe, expect, it, vi } from "vitest";
import type { Run, RunStep } from "@swarm/contracts";
import type { AgentRuntime, ThinkResult } from "./runtime";
import {
  ensureRunId,
  finishServiceThink,
  isIdleServiceReply,
  NO_SERVICE_ACTION_PROMPT,
  turnHasServiceAction,
} from "./service-work";

describe("ensureRunId", () => {
  it("prepends runId when missing", () => {
    expect(ensureRunId("run_1", "сделай задачу")).toMatch(/^runId этой задачи: run_1/);
    expect(ensureRunId("run_1", "runId этой задачи: run_1\n\nok")).toBe("runId этой задачи: run_1\n\nok");
  });
});

describe("isIdleServiceReply", () => {
  it("accepts empty and failure replies", () => {
    expect(isIdleServiceReply("пусто")).toBe(true);
    expect(isIdleServiceReply("Подключение готово, задач нет.")).toBe(true);
    expect(isIdleServiceReply("Не удалось выпустить ключ: нет доступа.")).toBe(true);
    expect(isIdleServiceReply("Задачу №12 завершил в Pneumatic.")).toBe(false);
  });
});

describe("turnHasServiceAction", () => {
  it("counts mcp/api/browser and credential report notes", () => {
    const since = "2026-01-01T00:00:10.000Z";
    const steps: RunStep[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "api", text: "раньше" },
      { at: "2026-01-01T00:00:11.000Z", kind: "model", text: "думаю" },
      { at: "2026-01-01T00:00:12.000Z", kind: "note", text: "подключён сервис Pneumatic (API)" },
    ];
    expect(turnHasServiceAction(steps, since)).toBe(true);
    expect(turnHasServiceAction(steps.slice(0, 2), since)).toBe(false);
    expect(turnHasServiceAction([{ at: since, kind: "browser", text: "открыл" }], since)).toBe(true);
  });
});

describe("finishServiceThink", () => {
  const run = { id: "run_1", status: "running" } as Run;

  function rt(args: {
    steps?: RunStep[];
    retry?: ThinkResult;
    getStatus?: string;
  }): AgentRuntime {
    let steps = args.steps ?? [];
    return {
      store: {
        getRun: async () => ({ ...run, status: args.getStatus ?? "running" }),
        listSteps: async () => steps,
      },
      think: vi.fn(async () => {
        const r = args.retry ?? { text: "пусто", usedFallback: false, startedAt: "2026-01-01T00:00:20.000Z" };
        steps = [...steps, { at: r.startedAt, kind: "model", text: r.text }];
        return r;
      }),
      step: vi.fn(async (_id: string, kind: RunStep["kind"], text: string) => {
        steps = [...steps, { at: new Date().toISOString(), kind, text }];
      }),
    } as unknown as AgentRuntime;
  }

  it("marks fallback without tools as failed", async () => {
    const r = await finishServiceThink(rt({}), run, {
      text: "Готово",
      usedFallback: true,
      startedAt: "2026-01-01T00:00:10.000Z",
    });
    expect(r.status).toBe("failed");
  });

  it("accepts a turn with a service step", async () => {
    const startedAt = "2026-01-01T00:00:10.000Z";
    const r = await finishServiceThink(
      rt({ steps: [{ at: startedAt, kind: "api", text: "GET /v3/tasks" }] }),
      run,
      { text: "Сделал задачу", usedFallback: false, startedAt },
    );
    expect(r).toEqual({ text: "Сделал задачу", status: "done" });
  });

  it("retries when there is no service action and accepts idle on retry", async () => {
    const mock = rt({
      retry: { text: "задач нет", usedFallback: false, startedAt: "2026-01-01T00:00:20.000Z" },
    });
    const r = await finishServiceThink(mock, run, {
      text: "Всё готово, задачи выполнены",
      usedFallback: false,
      startedAt: "2026-01-01T00:00:10.000Z",
    });
    expect(mock.think).toHaveBeenCalledWith(run, NO_SERVICE_ACTION_PROMPT, "hermes.retry");
    expect(r).toEqual({ text: "задач нет", status: "done" });
  });

  it("pauses for a numbered question instead of retrying", async () => {
    const ask = vi.fn(async () => ({ pendingId: "q1" }));
    const mock = rt({});
    (mock as unknown as { approvals: { ask: typeof ask } }).approvals = { ask };
    const text = [
      "Какой способ удобнее:",
      "1. Если у вас есть API ключ и токен Trello — передайте их",
      "2. Или я могу открыть Trello в браузере и выполнить задачу там",
      "На каком способе мы работаем?",
    ].join("\n");
    const r = await finishServiceThink(mock, run, {
      text,
      usedFallback: false,
      startedAt: "2026-01-01T00:00:10.000Z",
    });
    expect(ask).toHaveBeenCalledWith(
      "run_1",
      expect.stringContaining("На каком способе"),
      expect.arrayContaining([expect.stringContaining("API ключ")]),
    );
    expect(mock.think).not.toHaveBeenCalled();
    expect(r.status).toBe("waiting_approval");
  });

  it("fails when the retry still has no service action", async () => {
    const r = await finishServiceThink(
      rt({
        retry: { text: "Всё сделал в Pneumatic", usedFallback: false, startedAt: "2026-01-01T00:00:20.000Z" },
      }),
      run,
      { text: "Готово", usedFallback: false, startedAt: "2026-01-01T00:00:10.000Z" },
    );
    expect(r.status).toBe("failed");
    expect(r.text).toMatch(/сделал/i);
  });
});
