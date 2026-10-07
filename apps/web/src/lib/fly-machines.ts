import type { AgentRow } from "@swarm/agents";
import { FlyClient } from "@swarm/fly";
import { env } from "@/env";

const ASLEEP = new Set(["suspended", "stopped", "suspending"]);
const WAKING = new Set(["starting", "created", "replacing"]);

/** Пока срок не вышел, запрос «усни» игнорируется: работа только началась. */
const holdUntil = new Map<string, number>();

export function holdMachine(agentId: string, ms: number): void {
  const until = Date.now() + ms;
  const prev = holdUntil.get(agentId) ?? 0;
  if (until > prev) holdUntil.set(agentId, until);
}

export function machineHeld(agentId: string): boolean {
  return (holdUntil.get(agentId) ?? 0) > Date.now();
}

function fly(): FlyClient | null {
  const token = env.fly.apiToken;
  if (!token) return null;
  return new FlyClient({ apiToken: token, org: env.fly.org, region: env.fly.region });
}

/** `null` — Fly не настроен, вызывающий сам решает, стучаться ли в runtime. */
export async function machineState(agent: AgentRow): Promise<string | null> {
  if (env.devRuntimeUrl) return "started";
  const client = fly();
  if (!client || !agent.flyAppName || !agent.flyMachineId) return null;
  const machine = await client.getMachine(agent.flyAppName, agent.flyMachineId);
  return machine?.state ?? null;
}

export function isAsleepState(state: string | null): boolean {
  return state !== null && ASLEEP.has(state);
}

export function isWakingState(state: string | null): boolean {
  return state !== null && WAKING.has(state);
}

/**
 * Поднять suspended/stopped машину и дождаться `started`.
 * Уже запущенную не трогает. `.internal` сам машину не будит.
 * Агентов на `.flycast` сюда не зовут: их поднимает сам HTTP-запрос.
 * `true` — машина только что поднялась и runtime может ещё не слушать порт.
 */
export async function wakeAgent(agent: AgentRow, holdMs = 30_000): Promise<boolean> {
  holdMachine(agent.id, holdMs);
  if (env.devRuntimeUrl) return false;
  const client = fly();
  if (!client || !agent.flyAppName || !agent.flyMachineId) return false;
  const machine = await client.getMachine(agent.flyAppName, agent.flyMachineId);
  if (!machine) throw new Error("Машина агента не найдена");
  if (machine.state === "started") return false;
  if (!isWakingState(machine.state)) {
    await client.startMachine(agent.flyAppName, agent.flyMachineId);
  }
  // `created` — машина ещё ни разу не стартовала: Fly тянет образы, на новом хосте это минуты.
  const waitSec = machine.state === "created" ? FIRST_BOOT_WAIT_SEC : WAKE_WAIT_SEC;
  await client.waitForState(agent.flyAppName, agent.flyMachineId, "started", waitSec);
  return true;
}

const WAKE_WAIT_SEC = 90;
const FIRST_BOOT_WAIT_SEC = 300;

/** Усыпить, если после wake не пришла новая работа. Идемпотентно. */
export async function suspendAgent(agent: AgentRow): Promise<"suspended" | "skipped"> {
  if (machineHeld(agent.id)) return "skipped";
  if (env.devRuntimeUrl) return "skipped";
  const client = fly();
  if (!client || !agent.flyAppName || !agent.flyMachineId) return "skipped";
  const machine = await client.getMachine(agent.flyAppName, agent.flyMachineId);
  if (!machine || machine.state !== "started") return "skipped";
  if (machineHeld(agent.id)) return "skipped";
  await client.suspendMachine(agent.flyAppName, agent.flyMachineId);
  return "suspended";
}
