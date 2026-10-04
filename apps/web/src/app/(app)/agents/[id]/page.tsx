import { notFound } from "next/navigation";
import { getAgent, toAgentView } from "@swarm/agents";
import { requireViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { AgentDashboard } from "@/components/agent-dashboard";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;
  const row = await getAgent(db(), viewer.tenant.id, id);
  if (!row) notFound();
  return <AgentDashboard initialAgent={toAgentView(row)} />;
}
