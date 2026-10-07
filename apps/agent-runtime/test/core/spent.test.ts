import { describe, expect, it } from "vitest";
import type { Run } from "@swarm/contracts";
import { beginWork, formatSpent, replyWithSpent, settleWork } from "../../src/core/spent";

function run(patch: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    startedAt: "2026-10-07T10:00:00.000Z",
    finishedAt: null,
    status: "running",
    trigger: "chat",
    title: "Починить карточку",
    summary: "",
    threadId: null,
    activeMs: 0,
    activeSince: "2026-10-07T10:00:00.000Z",
    ...patch,
  };
}

describe("время задачи", () => {
  it("копит работу и не считает паузу, пока человек отвечает", () => {
    const task = run();
    const start = Date.parse(task.activeSince!);
    settleWork(task, start + 4 * 60_000);
    expect(task.activeMs).toBe(4 * 60_000);
    expect(task.activeSince).toBeNull();

    beginWork(task, new Date(start + 2 * 60 * 60_000).toISOString());
    settleWork(task, start + 2 * 60 * 60_000 + 90_000);
    expect(task.activeMs).toBe(4 * 60_000 + 90_000);
  });

  it("старой задаче без учёта засчитывает уже закрытый отрезок и продолжает с него", () => {
    const task = run({
      activeMs: undefined,
      activeSince: undefined,
      status: "done",
      finishedAt: "2026-10-07T10:05:00.000Z",
    });
    beginWork(task, "2026-10-07T12:00:00.000Z");
    expect(task.activeMs).toBe(5 * 60_000);
    settleWork(task, Date.parse("2026-10-07T12:02:00.000Z"));
    expect(task.activeMs).toBe(7 * 60_000);
  });

  it("пишет итог в ответ и не портит вопрос с вариантами", () => {
    expect(formatSpent(45_000)).toBe("45 с");
    expect(formatSpent(90_000)).toBe("2 мин");
    expect(formatSpent(3_660_000)).toBe("1 ч 1 мин");
    const done = run({ status: "done", activeMs: 90_000, activeSince: null });
    expect(replyWithSpent("Карточка закрыта.", done)).toBe("Карточка закрыта.\n\nЗаняло 2 мин.");
    expect(replyWithSpent("Карточка закрыта.\n\nЗаняло 2 мин.", done)).toBe("Карточка закрыта.\n\nЗаняло 2 мин.");
    const question = "Что выбрать?\n1. API\n2. Браузер";
    expect(replyWithSpent(question, done)).toBe(question);
    expect(replyWithSpent("Не вышло.", run({ status: "failed", activeMs: 90_000 }))).toBe("Не вышло.");
  });
});
