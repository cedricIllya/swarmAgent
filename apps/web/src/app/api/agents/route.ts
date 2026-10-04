import { NextResponse } from "next/server";
import { CreateAgentInputSchema } from "@swarm/contracts";
import { listAgents, toAgentView } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { createAgent } from "@/lib/create-agent";

export async function GET(): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ agents: await listAgents(db(), viewer.tenant.id) });
}

export async function POST(req: Request): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = CreateAgentInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad input" }, { status: 400 });
  try {
    const row = await createAgent(viewer.tenant, { email: viewer.user.email }, parsed.data);
    return NextResponse.json({ agent: toAgentView(row) }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 400 });
  }
}
