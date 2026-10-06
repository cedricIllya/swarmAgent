import { describe, expect, it, vi } from "vitest";
import type { Run } from "@swarm/contracts";
import type { AgentRuntime } from "../../src/runtime";
import { continueFinishedAnswer, takeFinishedAnswer } from "../../src/tasks/question-reply";

const ATLASSIAN = [
  "Письмо содержит информацию о попытке входа.",
  "Нужно, чтобы ты сам выбрал:",
  '1. Если это действительно была твоя попытка входа из Вены — нажми "This was me"',
  '2. Если это не ты — нажми "This wasn\'t me", чтобы защитить аккаунт',
  "Что мне делать с этим уведомлением?",
].join("\n");

function run(status: Run["status"], summary = ATLASSIAN): Run {
  return {
    id: "run_mail",
    startedAt: "2026-10-06T22:49:11.000Z",
    finishedAt: "2026-10-06T22:50:51.000Z",
    status,
    trigger: "email",
    title: "Unusual login attempts on your Atlassian account",
    summary,
    threadId: "<010101a11367d0dc@us-west-2.amazonses.com>",
  };
}

function rt(current: Run | null, approvals: Array<{ runId: string }> = []): { mock: AgentRuntime; chats: string[] } {
  let saved: Run | null = current;
  const chats: string[] = [];
  const mock = {
    store: {
      getRun: async () => saved,
      saveRun: async (next: Run) => {
        saved = next;
      },
      listApprovals: async () => approvals,
    },
    chatIdForRun: async () => "chat_system",
    addChat: vi.fn(async (msg: { text: string }) => {
      chats.push(msg.text);
    }),
    step: vi.fn(async () => undefined),
    isCanceled: async () => false,
    think: async () => ({ text: "не смог открыть Atlassian", usedFallback: false, startedAt: "2026-10-06T22:51:00.000Z" }),
    finishRun: async (next: Run, status: Run["status"], summary: string) => {
      next.status = status;
      next.summary = summary;
    },
  } as unknown as AgentRuntime & { store: { listSteps: () => Promise<unknown[]> } };
  (mock.store as { listSteps: () => Promise<unknown[]> }).listSteps = async () => [
    { at: "2026-10-06T22:51:00.000Z", kind: "note", text: "ответ человека получен" },
  ];
  return { mock, chats };
}

describe("takeFinishedAnswer", () => {
  it("reopens a finished email task instead of looking up the message id as a chat", async () => {
    const { mock, chats } = rt(run("failed"));
    const taken = await takeFinishedAnswer(mock, "run_mail", "This wasn't me");
    expect(taken?.answer).toBe("This wasn't me");
    expect(taken?.chatId).toBe("chat_system");
    expect(taken?.run.status).toBe("running");
    expect(taken?.run.threadId).toContain("010101");
    expect(chats).toEqual(["This wasn't me"]);
    await continueFinishedAnswer(mock, taken!);
  });

  it("refuses a task that is still running", async () => {
    const { mock } = rt(run("running", "1. Да\n2. Нет\nЧто выбрать?"));
    expect(await takeFinishedAnswer(mock, "run_mail", "Да")).toBeNull();
  });

  it("refuses a summary that is not a question", async () => {
    const { mock } = rt(run("failed", "Это информационное письмо, задачи нет."));
    expect(await takeFinishedAnswer(mock, "run_mail", "ок")).toBeNull();
  });

  it("continues an escalated task from the owner's note even without a numbered question", async () => {
    const reason = "Не прошёл проверку на странице, нужен человек. Браузер уже закрыт, взять управление некуда.";
    const { mock, chats } = rt(run("escalated", reason));
    const taken = await takeFinishedAnswer(mock, "run_mail", "Капчу прошёл, аккаунт активен");
    expect(taken?.kind).toBe("escalation");
    expect(taken?.question).toBe(reason);
    expect(taken?.run.status).toBe("running");
    expect(chats).toEqual(["Капчу прошёл, аккаунт активен"]);
    await continueFinishedAnswer(mock, taken!);
  });

  it("leaves an escalated task with a pending handoff card to its buttons", async () => {
    const { mock } = rt(run("escalated", "Нужна помощь со входом."), [{ runId: "run_mail" }]);
    expect(await takeFinishedAnswer(mock, "run_mail", "готово")).toBeNull();
  });
});
