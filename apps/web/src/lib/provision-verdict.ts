/**
 * Что делать с застрявшим агентом по состоянию его машины.
 * `started` — агент работает. `created`/`starting` — первый старт ещё идёт.
 * Уснувшая машина у агента в `provisioning` когда-то стартовала, значит он рабочий;
 * у `failed` она ни о чём не говорит — ошибку оставляем человеку.
 */
export function provisionVerdict(agentStatus: string, machineState: string | null): "running" | "booting" | "leave" {
  if (machineState === "started") return "running";
  if (machineState === "created" || machineState === "starting") return "booting";
  if (agentStatus === "provisioning" && (machineState === "stopped" || machineState === "suspended")) return "running";
  return "leave";
}
