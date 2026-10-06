import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@swarm/contracts";
import { chatRetrySource } from "../../src/tasks/chat";

function msg(partial: Pick<ChatMessage, "role" | "text" | "runId"> & Partial<ChatMessage>): ChatMessage {
  return {
    at: "2026-01-01T00:00:00.000Z",
    chatId: "c1",
    kind: "text",
    ...partial,
  };
}

describe("chatRetrySource", () => {
  it("uses the person's message of the failed task", () => {
    const messages = [
      msg({ role: "user", text: "  прими приглашение  ", runId: "run-a" }),
      msg({ role: "agent", text: "Не получилось.", runId: "run-a" }),
    ];
    expect(chatRetrySource(messages, "run-a")).toBe("прими приглашение");
  });

  it("walks back when the retry itself has no person message", () => {
    const messages = [
      msg({ role: "user", text: "первая", runId: "run-a" }),
      msg({ role: "agent", text: "ошибка", runId: "run-a" }),
      msg({ role: "agent", text: "снова ошибка", runId: "run-b" }),
    ];
    expect(chatRetrySource(messages, "run-b")).toBe("первая");
  });

  it("does not take an approval tap as the task text", () => {
    const messages = [
      msg({ role: "user", text: "сделай отчёт", runId: "run-a" }),
      msg({ role: "user", text: "Да", runId: "run-a", kind: "approval" }),
      msg({ role: "agent", text: "ошибка", runId: "run-b" }),
    ];
    expect(chatRetrySource(messages, "run-b")).toBe("сделай отчёт");
  });
});
