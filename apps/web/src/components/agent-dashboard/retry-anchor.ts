import type { ChatMessage } from "@swarm/contracts";

/** Куда повесить «Повторить»: последнее обычное сообщение упавшей или остановленной задачи. */
export function retryBubbleIndexes(messages: ChatMessage[], failedRunIds: Set<string>): Set<number> {
  const last = new Map<string, number>();
  messages.forEach((m, i) => {
    if (!m.runId || !failedRunIds.has(m.runId)) return;
    if (m.kind === "browser" || m.kind === "approval") return;
    last.set(m.runId, i);
  });
  return new Set(last.values());
}
