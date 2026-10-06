const RAN = new Set(["started", "stopping", "stopped", "suspending", "suspended"]);
const BOOTING = new Set(["created", "starting"]);

/**
 * Что делать с застрявшим агентом по состоянию его машины.
 * Когда у агента уже есть машина, provision мог сорваться только на ожидании её старта,
 * поэтому машина, которая хоть раз стартовала (в том числе уже уснувшая), — рабочий агент.
 * `created`/`starting` — первый старт ещё идёт. Нет машины или `failed`/`destroyed` — ошибку оставляем человеку.
 */
export function provisionVerdict(machineState: string | null): "running" | "booting" | "leave" {
  if (machineState === null) return "leave";
  if (RAN.has(machineState)) return "running";
  if (BOOTING.has(machineState)) return "booting";
  return "leave";
}
