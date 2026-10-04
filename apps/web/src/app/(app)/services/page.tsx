import { listAgents } from "@swarm/agents";
import { listTenantConnections } from "@swarm/connections";
import { requireViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { ServicesOverview } from "@/components/services-overview";

export const dynamic = "force-dynamic";

export default async function ServicesPage() {
  const viewer = await requireViewer();
  const [agents, connections] = await Promise.all([
    listAgents(db(), viewer.tenant.id),
    listTenantConnections(db(), viewer.tenant.id),
  ]);
  return <ServicesOverview agents={agents} connections={connections} />;
}
