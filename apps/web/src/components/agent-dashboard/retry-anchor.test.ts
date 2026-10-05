import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@swarm/contracts";
import { retryBubbleIndexes } from "./retry-anchor";

function msg(partial: Pick<ChatMessage, "role" | "text" | "runId"> & Partial<ChatMessage>): ChatMessage {
  return { at: "2026-01-01T00:00:00.000Z", chatId: "c1", ...partial };
}

describe("retryBubbleIndexes", () => {
  it("puts the button on the last plain message of a failed task", () => {
    const messages = [
      msg({ role: "user", text: "привет", runId: "run-a" }),
      msg({ role: "agent", text: "Не получилось.", runId: "run-a" }),
      msg({ role: "agent", text: "готово", runId: "run-b" }),
    ];
    expect([...retryBubbleIndexes(messages, new Set(["run-a"]))]).toEqual([1]);
  });

  it("skips browser cards and keeps the error text", () => {
    const messages = [
      msg({ role: "user", text: "войди", runId: "run-a" }),
      msg({ role: "agent", text: "Не получилось.", runId: "run-a" }),
      msg({ role: "agent", text: "", runId: "run-a", kind: "browser", sessionId: "s1" }),
    ];
    expect([...retryBubbleIndexes(messages, new Set(["run-a"]))]).toEqual([1]);
  });
});
