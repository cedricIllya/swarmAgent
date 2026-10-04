import { listAgents } from "@swarm/agents";
import { requireViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { AgentsHome } from "@/components/agents-home";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const viewer = await requireViewer();
  const agents = await listAgents(db(), viewer.tenant.id);
  return <AgentsHome initialAgents={agents} />;
}
