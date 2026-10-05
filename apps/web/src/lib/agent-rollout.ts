import type { AgentRow } from "@swarm/agents";
import { and, eq, isNull, ne, or, schema } from "@swarm/db";
import { env } from "@/env";
import { reconfigureAgent } from "@/lib/create-agent";
import { db } from "@/lib/db";
import { isAsleepState, machineState } from "@/lib/fly-machines";
import { rolloutIdle } from "@/lib/rollout-idle";
import { RuntimeClient } from "@/lib/runtime-client";

/**
 * Перевод уже созданных агентов на образ runtime этого релиза.
 * Машина обновляется только когда ей нечего терять: нет идущей задачи и
 * браузер не ждёт код из письма. Занятые агенты дожидаются следующего прохода.
 */

export type RolloutOutcome = "updated" | "busy" | "skipped" | "failed";

export interface RolloutSummary {
  release: string | null;
  updated: number;
  busy: number;
  skipped: number;
  failed: number;
}

/** Владелец тенанта — тот, чья почта стоит в OWNER_EMAIL машины. Нет владельца — самый ранний участник. */
async function ownerEmailFor(tenantId: string): Promise<string | null> {
  const rows = await db()
    .select({ email: schema.users.email, role: schema.memberships.role, joinedAt: schema.memberships.createdAt })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.tenantId, tenantId));
  const byAge = (a: { joinedAt: Date }, b: { joinedAt: Date }) => a.joinedAt.getTime() - b.joinedAt.getTime();
  const owner = rows.filter((r) => r.role === "owner").sort(byAge)[0] ?? [...rows].sort(byAge)[0];
  return owner?.email ?? null;
}

async function staleAgents(release: string): Promise<AgentRow[]> {
  return db()
    .select()
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.status, "running"),
        or(isNull(schema.agents.runtimeRelease), ne(schema.agents.runtimeRelease, release)),
      ),
    );
}

async function rolloutOne(agent: AgentRow): Promise<RolloutOutcome> {
  if (!agent.flyAppName || !agent.flyMachineId || !agent.flyVolumeId) return "skipped";
  const state = await machineState(agent);
  if (state === null) return "skipped";
  if (!isAsleepState(state)) {
    // Спящая машина простаивает по определению: runtime сам попросил suspend.
    // Запущенную спрашиваем; переходные состояния пропускаем до следующего раза.
    if (state !== "started") return "busy";
    const client = RuntimeClient.for(agent);
    if (!client) return "skipped";
    if (!rolloutIdle(await client.state())) return "busy";
  }
  await reconfigureAgent(agent.id, await ownerEmailFor(agent.tenantId));
  return "updated";
}

/** Обновить всех отставших агентов, по несколько за раз. Без RELEASE сравнивать не с чем. */
export async function rolloutAgents(concurrency = 3): Promise<RolloutSummary> {
  const release = env.release ?? null;
  const summary: RolloutSummary = { release, updated: 0, busy: 0, skipped: 0, failed: 0 };
  if (!release) return summary;

  const queue = await staleAgents(release);
  const worker = async () => {
    for (let agent = queue.shift(); agent; agent = queue.shift()) {
      try {
        const outcome = await rolloutOne(agent);
        summary[outcome] += 1;
        if (outcome === "updated") console.log(`[rollout] ${agent.id} → ${release.slice(0, 12)}`);
      } catch (e) {
        summary.failed += 1;
        console.warn(`[rollout] ${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return summary;
}
