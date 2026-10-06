export type TaskLogTone = "attention" | "live" | "settled";

/**
 * Задача ещё в работе, даже если без человека её не продолжить.
 * В архив она попадает только после решения: одобрения, ответа или остановки.
 */
export function waitingOnPerson(status: string, pendingDecision: boolean): boolean {
  return pendingDecision || status === "waiting_approval" || status === "escalated";
}

/** Ключ строки журнала не меняется, когда заготовка local_* становится настоящим прогоном. */
export function transferRunKey(keys: Map<string, string>, fromId: string, toId: string): void {
  if (fromId === toId) return;
  const fromKey = keys.get(fromId);
  if (fromKey) {
    keys.set(toId, fromKey);
    keys.delete(fromId);
    return;
  }
  if (!keys.has(toId)) keys.set(toId, fromId);
}

export function runListKey(keys: Map<string, string>, id: string): string {
  const existing = keys.get(id);
  if (existing) return existing;
  keys.set(id, id);
  return id;
}

/**
 * Открытая задача остаётся в своей секции, даже когда статус становится «завершено».
 * Иначе строка переезжает в свёрнутый архив: журнал закрывается и страница прыгает.
 */
export function partitionTaskLog<T>(
  ranked: Array<{ key: string; tone: TaskLogTone; value: T }>,
  isOpen: (key: string) => boolean,
  pinned: Map<string, "attention" | "live">,
): { top: T[]; archive: T[] } {
  for (const item of ranked) {
    if (!isOpen(item.key)) {
      pinned.delete(item.key);
      continue;
    }
    if (item.tone !== "settled" && !pinned.has(item.key)) pinned.set(item.key, item.tone);
  }
  const toneOf = (item: (typeof ranked)[number]): TaskLogTone | "archive" => {
    if (item.tone !== "settled") return item.tone;
    return pinned.get(item.key) ?? "archive";
  };
  return {
    top: [
      ...ranked.filter((item) => toneOf(item) === "attention").map((item) => item.value),
      ...ranked.filter((item) => toneOf(item) === "live").map((item) => item.value),
    ],
    archive: ranked.filter((item) => toneOf(item) === "archive").map((item) => item.value),
  };
}
