import { getAgentById } from "@swarm/agents";
import { agentIdsWithCredentials } from "@swarm/connections";
import { eq, schema } from "@swarm/db";
import { rolloutAgents } from "@/lib/agent-rollout";
import { reconcileProvisioning } from "@/lib/create-agent";
import { db } from "@/lib/db";
import { retryInboundMail } from "@/lib/mail-delivery";
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

/** Машины, чей первый старт пережил ожидание или перезапуск control plane. */
async function runReconcile(): Promise<void> {
  try {
    const r = await reconcileProvisioning();
    if (r.recovered || r.booting) console.log(`[provision] запустились ${r.recovered}, ещё поднимаются ${r.booting}`);
  } catch (e) {
    console.warn(`[provision] проверка не вышла: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Пока сайт не спит — раз в 15 минут. После suspend таймеры замирают;
 * большой разрыв в пульсе значит, что Fly только что разбудил процесс,
 * и пропущенную проверку надо сделать сразу.
 * Агентов без сервисов, где есть или ещё не классифицированы задачи, не будим.
 * Мессенджер будит: тик читает новые сообщения. Оплату и ключи тик не смотрит,
 * отложенная почта дождётся следующего письма.
 */
async function runTicks(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runReconcile();
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
  // Пока чья-то машина поднимается впервые, статус должен обновиться за минуту, а не за четверть часа.
  // Без застрявших агентов это один запрос к базе и ни одного к Fly.
  setInterval(() => void runReconcile(), 60_000);
  // Письмо, которое не дождалось подъёма машины. Пустая очередь — это возврат без запросов.
  setInterval(() => void retryInboundMail(), 60_000);
  // Новый процесс — это чаще всего новая выкладка: агентов надо перевести на её образ сразу.
  setTimeout(() => void runTicks(), 20_000);
  console.log("[clock] проверка агентов раз в 15 минут, пока этот процесс не спит");
}
