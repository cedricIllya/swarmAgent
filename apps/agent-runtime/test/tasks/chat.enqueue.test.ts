import { describe, expect, it, vi } from "vitest";
import type { Run } from "@swarm/contracts";
import { handleChat } from "../../src/tasks/chat";
import type { AgentRuntime } from "../../src/runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("handleChat", () => {
  it("ставит задачу в журнал до разбора сообщения", async () => {
    const gate = deferred<{
      text: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      model: string;
      citations: [];
    }>();
    const runs: Run[] = [];
    const messages: string[] = [];
    let renamed: string | null = null;
    const think = vi.fn(async () => ({
      text: "задач нет",
      usedFallback: false,
      startedAt: "2026-01-01T00:00:00.000Z",
    }));
    const rt = {
      model: "test",
      isCanceled: async () => false,
      openRouter: { chat: vi.fn(() => gate.promise) },
      services: { knownRecipe: vi.fn(async () => null) },
      store: {
        chats: {
          create: async (title: string) => ({ id: "chat-1", title }),
          get: async () => ({ id: "chat-1", title: "создай задачу в Linear" }),
          rename: async (_id: string, title: string) => {
            renamed = title;
            return null;
          },
        },
        saveRun: async (run: Run) => {
          runs[0] = { ...run };
        },
        getRun: async () => runs[0] ?? null,
        listSteps: async () => [],
        addUsage: async () => undefined,
      },
      createRun: async (_trigger: string, title: string, threadId: string | null) => {
        const run = {
          id: "run-1",
          title,
          threadId,
          status: "running",
          trigger: "chat",
          startedAt: "",
          finishedAt: null,
          summary: "",
        } as Run;
        runs[0] = run;
        return run;
      },
      addChat: async (m: { text: string }) => {
        messages.push(m.text);
      },
      step: vi.fn(async () => undefined),
      finishRun: async (run: Run, status: Run["status"], summary: string) => {
        run.status = status;
        run.summary = summary;
      },
      think,
    } as unknown as AgentRuntime;

    const result = await handleChat(rt, { message: "создай задачу в Linear", author: "a@b.c" });

    expect(result?.run.id).toBe("run-1");
    expect(result?.run.title).toBe("создай задачу в Linear");
    expect(messages).toEqual(["создай задачу в Linear"]);
    expect(think).not.toHaveBeenCalled();

    gate.resolve({
      text: JSON.stringify({ kind: "credential", service: "Linear", serviceDomain: "linear.app" }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [],
    });

    await vi.waitFor(() => expect(think).toHaveBeenCalled());
    expect(result?.run.title).toBe("Ключ: Linear");
    expect(renamed).toBe("Ключ: Linear");
  });
});
