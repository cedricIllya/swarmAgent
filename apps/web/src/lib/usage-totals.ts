import type { UsageTotals } from "@swarm/contracts";

/**
 * Откуда цифры агента:
 * `live` — только что с машины; `saved` — итоги, которые машина отдала перед сном;
 * `unknown` — агент работает, но ни машина, ни база ничего не сказали;
 * `empty` — агент ещё не запускался, тратить было нечего.
 */
export type AgentUsageSource = "live" | "saved" | "unknown" | "empty";

export interface AgentUsage extends UsageTotals {
  id: string;
  name: string;
  source: AgentUsageSource;
  /** Когда сняты итоги. Без данных — null. */
  at: string | null;
}

export interface TenantUsage extends UsageTotals {
  agents: AgentUsage[];
}

/** Строка `agents` в части, которая нужна для итогов. */
export interface UsageRowLike {
  id: string;
  name: string;
  status: string;
  usageCostUsd: number | null;
  usagePromptTokens: number | null;
  usageCompletionTokens: number | null;
  usageAt: Date | null;
}

export const ZERO_USAGE: UsageTotals = { totalCostUsd: 0, totalPromptTokens: 0, totalCompletionTokens: 0 };

export function sumUsage(agents: AgentUsage[]): TenantUsage {
  const totals = agents.reduce<UsageTotals>(
    (acc, a) => ({
      totalCostUsd: acc.totalCostUsd + a.totalCostUsd,
      totalPromptTokens: acc.totalPromptTokens + a.totalPromptTokens,
      totalCompletionTokens: acc.totalCompletionTokens + a.totalCompletionTokens,
    }),
    ZERO_USAGE,
  );
  return { ...totals, agents };
}

/** Пояснение под цифрами: кто посчитан по старому отчёту, а кто не учтён вовсе. */
export function usageCaveat(agents: AgentUsage[]): string | null {
  const saved = agents.some((a) => a.source === "saved");
  const unknown = agents.filter((a) => a.source === "unknown");
  const parts: string[] = [];
  if (saved) parts.push("Спящие агенты посчитаны по итогам, которые машина отдала перед сном.");
  if (unknown.length) parts.push(`Не учтены: ${unknown.map((a) => a.name).join(", ")} — машина ещё не отчиталась.`);
  return parts.length ? parts.join(" ") : null;
}

/** Итоги из базы: их машина отдала перед сном или control plane снял с `/state`. */
export function savedUsage(row: UsageRowLike): AgentUsage {
  const base = { id: row.id, name: row.name };
  if (row.usageAt === null || row.usagePromptTokens === null || row.usageCompletionTokens === null) {
    return { ...base, ...ZERO_USAGE, source: row.status === "running" ? "unknown" : "empty", at: null };
  }
  return {
    ...base,
    totalCostUsd: row.usageCostUsd ?? 0,
    totalPromptTokens: row.usagePromptTokens,
    totalCompletionTokens: row.usageCompletionTokens,
    source: "saved",
    at: row.usageAt.toISOString(),
  };
}
