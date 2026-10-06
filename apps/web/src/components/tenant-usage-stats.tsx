import type { AgentRow } from "@swarm/agents";
import { collectTenantUsage } from "@/lib/tenant-usage";
import { UsageStats } from "./usage-stats";

/** Серверный блок: ходит в машины агентов, поэтому страница отдаёт его отдельно, через Suspense. */
export async function TenantUsageStats({ agents }: { agents: AgentRow[] }) {
  return <UsageStats usage={await collectTenantUsage(agents)} />;
}
