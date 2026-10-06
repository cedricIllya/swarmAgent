import { describe, expect, it } from "vitest";
import type { InboundEmail } from "@swarm/contracts";
import { createUndeliveredMailQueue } from "./undelivered-mail";

function email(messageId: string, subject = "Приглашение"): InboundEmail {
  return {
    sender: "notification@atsendly.online",
    from: "notification@atsendly.online",
    to: "bot@example.com",
    subject,
    text: "ссылка",
    html: "",
    headers: {},
    messageId,
    inReplyTo: null,
    references: [],
    dkimDomains: [],
    replyText: "ссылка",
    links: [],
    spf: null,
    dkim: null,
    receivedAt: "2026-10-06T12:10:42Z",
  };
}

describe("undelivered mail", () => {
  it("повторно кладёт то же письмо один раз и отдаёт его, когда runtime ответил", async () => {
    const queue = createUndeliveredMailQueue();
    queue.enqueue({ agentId: "agt_1", email: email("<a@x>"), enqueuedAt: 0 });
    queue.enqueue({ agentId: "agt_1", email: email("<a@x>"), enqueuedAt: 1 });
    expect(queue.size()).toBe(1);

    const seen: string[] = [];
    const result = await queue.drain(async (agentId) => {
      seen.push(agentId);
      return true;
    }, 1_000);
    expect(seen).toEqual(["agt_1"]);
    expect(result).toEqual({ delivered: 1, dropped: 0, left: 0 });
  });

  it("неудачная доставка остаётся в очереди, просроченная — нет", async () => {
    const queue = createUndeliveredMailQueue(1_000);
    queue.enqueue({ agentId: "agt_1", email: email("<fresh@x>", "свежее"), enqueuedAt: 5_000 });
    queue.enqueue({ agentId: "agt_1", email: email("<old@x>", "старое"), enqueuedAt: 0 });

    const result = await queue.drain(async () => false, 5_500);
    expect(result).toEqual({ delivered: 0, dropped: 1, left: 1 });
    expect(queue.size()).toBe(1);
  });

  it("второй drain во время первого ничего не забирает", async () => {
    const queue = createUndeliveredMailQueue();
    const now = Date.now();
    queue.enqueue({ agentId: "agt_1", email: email("<a@x>"), enqueuedAt: now });
    let overlap: number | null = null;
    const first = queue.drain(async () => {
      overlap = queue.size();
      const second = await queue.drain(async () => true);
      expect(second.delivered).toBe(0);
      return true;
    }, now);
    expect((await first).delivered).toBe(1);
    expect(overlap).toBe(0);
  });
});
