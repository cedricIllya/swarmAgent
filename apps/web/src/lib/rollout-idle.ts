import type { RuntimeState } from "@swarm/contracts";

/**
 * Можно ли перезапустить машину агента прямо сейчас.
 * Перезапуск оборвал бы идущую задачу или браузер, который ждёт код из письма.
 * Вопрос к владельцу (`waiting_approval`) перезапуск переживает: он лежит на диске.
 */
export function rolloutIdle(state: Pick<RuntimeState, "runs" | "busyInBrowser">): boolean {
  if (state.busyInBrowser) return false;
  return !state.runs.some((r) => r.status === "running" || r.status === "queued");
}
