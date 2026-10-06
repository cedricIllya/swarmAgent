import { Suspense } from "react";
import { listAgentRows, toAgentView } from "@swarm/agents";
import { loginFromEmail } from "@swarm/mail";
import { requireViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { AgentsHome } from "@/components/agents-home";
import { TenantUsageStats } from "@/components/tenant-usage-stats";
import { UsageStatsSkeleton } from "@/components/usage-stats";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const viewer = await requireViewer();
  const rows = await listAgentRows(db(), viewer.tenant.id);
  // Расходы собираются с машин агентов и приходят позже списка: список не ждёт.
  const usage = rows.length ? (
    <Suspense fallback={<UsageStatsSkeleton />}>
      <TenantUsageStats agents={rows} />
    </Suspense>
  ) : null;
  return <AgentsHome initialAgents={rows.map(toAgentView)} ownerLogin={loginFromEmail(viewer.user.email)} usage={usage} />;
}
