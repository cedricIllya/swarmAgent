import { getAgentById } from "@swarm/agents";
import { agentIdsWithCredentials } from "@swarm/connections";
import { eq, schema } from "@swarm/db";
import { rolloutAgents } from "@/lib/agent-rollout";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";

const g = globalThis as { __swarmClock?: boolean };

let ticking = false;
let beat = Date.now();

/** Сначала перевести отставших агентов на образ этого релиза, занятых — в следующий раз. */
async function runRollout(): Promise<void> {
  try {
    const r = await rolloutAgents();
    if (r.updated || r.busy || r.failed) {
      console.log(`[rollout] обновлено ${r.updated}, заняты ${r.busy}, ошибок ${r.failed}`);
    }
  } catch (e) {
    console.warn(`[rollout] не вышло: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Пока сайт не спит — раз в 15 минут. После suspend таймеры замирают;
 * большой разрыв в пульсе значит, что Fly только что разбудил процесс,
 * и пропущенную проверку надо сделать сразу.
 * Агентов без собственных секретов сервисов не будим: тику там нечего смотреть,
 * отложенная почта дождётся следующего письма.
 */
async function runTicks(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runRollout();
    const database = db();
    const [agents, withCreds] = await Promise.all([
      database.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.status, "running")),
      agentIdsWithCredentials(database),
    ]);
    for (const row of agents) {
      if (!withCreds.has(row.id)) continue;
      try {
        const agent = await getAgentById(database, row.id);
        if (!agent) continue;
        const client = await awakeRuntime(agent, 15_000);
        if (!client) continue;
        await client.tick();
      } catch (e) {
        console.warn(`[clock] ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    console.warn(`[clock] тик не вышел: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    ticking = false;
  }
}

export function startAgentClock(): void {
  if (g.__swarmClock) return;
  g.__swarmClock = true;
  setInterval(() => {
    const now = Date.now();
    const gap = now - beat;
    beat = now;
    if (gap > 30_000) void runTicks();
  }, 5_000);
  setInterval(() => void runTicks(), 15 * 60 * 1000);
  // Новый процесс — это чаще всего новая выкладка: агентов надо перевести на её образ сразу.
  setTimeout(() => void runTicks(), 20_000);
  console.log("[clock] проверка агентов раз в 15 минут, пока этот процесс не спит");
}
