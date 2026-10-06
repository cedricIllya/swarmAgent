import type { InboundEmail } from "@swarm/contracts";

/** Сколько держим письмо, которое не удалось отдать в runtime. */
export const MAIL_RETRY_TTL_MS = 30 * 60 * 1000;

export interface PendingMail {
  agentId: string;
  email: InboundEmail;
  enqueuedAt: number;
}

export interface MailDrainResult {
  delivered: number;
  dropped: number;
  left: number;
}

/**
 * Письма, которые webhook принял, но runtime не взял: машина засыпала,
 * ещё не создана или не успела подняться. Память процесса: выкладка control plane
 * очередь обнуляет, поэтому первая попытка должна быть длинной.
 */
export function createUndeliveredMailQueue(ttlMs = MAIL_RETRY_TTL_MS) {
  const pending: PendingMail[] = [];
  let draining = false;

  return {
    size: (): number => pending.length,

    enqueue(item: PendingMail): void {
      const id = item.email.messageId;
      if (id && pending.some((p) => p.agentId === item.agentId && p.email.messageId === id)) return;
      pending.push(item);
    },

    async drain(
      deliver: (agentId: string, email: InboundEmail) => Promise<boolean>,
      now = Date.now(),
    ): Promise<MailDrainResult> {
      if (draining) return { delivered: 0, dropped: 0, left: pending.length };
      draining = true;
      let delivered = 0;
      let dropped = 0;
      try {
        const batch = pending.splice(0, pending.length);
        const again: PendingMail[] = [];
        for (const item of batch) {
          if (now - item.enqueuedAt > ttlMs) {
            dropped += 1;
            console.error(`[mail] письмо ${item.agentId} «${item.email.subject}» не доставлено за ${Math.round(ttlMs / 60000)} мин, больше не повторяю`);
            continue;
          }
          const ok = await deliver(item.agentId, item.email).catch(() => false);
          if (ok) delivered += 1;
          else again.push(item);
        }
        pending.unshift(...again);
      } finally {
        draining = false;
      }
      return { delivered, dropped, left: pending.length };
    },
  };
}

export const inboundMail = createUndeliveredMailQueue();
