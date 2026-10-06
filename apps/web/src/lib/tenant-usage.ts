import { after } from "next/server";
import { rememberAgentUsage, type AgentRow } from "@swarm/agents";
import type { UsageTotals } from "@swarm/contracts";
import { db } from "@/lib/db";
import { isAsleepState, isWakingState, machineState } from "@/lib/fly-machines";
import { RuntimeClient } from "@/lib/runtime-client";
import { savedUsage, sumUsage, type AgentUsage, type TenantUsage } from "@/lib/usage-totals";

/**
 * Живые итоги с машины, если она не спит. Спящую не будим: расходы берём из базы.
 * Свежие итоги попутно запоминаем — пригодятся, если машина уснёт без отчёта.
 */
async function liveUsage(row: AgentRow): Promise<AgentUsage | null> {
  if (row.status !== "running") return null;
  const client = RuntimeClient.for(row);
  if (!client) return null;
  const fly = await machineState(row);
  if (isAsleepState(fly) || isWakingState(fly)) return null;
  const { usage } = await client.state();
  const totals: UsageTotals = {
    totalCostUsd: usage.totalCostUsd,
    totalPromptTokens: usage.totalPromptTokens,
    totalCompletionTokens: usage.totalCompletionTokens,
  };
  after(() =>
    rememberAgentUsage(db(), row.id, totals).catch((e) => console.warn(`[usage] ${row.id}: ${String(e)}`)),
  );
  return { id: row.id, name: row.name, ...totals, source: "live", at: new Date().toISOString() };
}

export async function agentUsage(row: AgentRow): Promise<AgentUsage> {
  try {
    const live = await liveUsage(row);
    if (live) return live;
  } catch (e) {
    console.warn(`[usage] ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return savedUsage(row);
}

/** Расходы всех агентов тенанта. Машины опрашиваются параллельно, спящие — не будятся. */
export async function collectTenantUsage(rows: AgentRow[]): Promise<TenantUsage> {
  return sumUsage(await Promise.all(rows.map(agentUsage)));
}
