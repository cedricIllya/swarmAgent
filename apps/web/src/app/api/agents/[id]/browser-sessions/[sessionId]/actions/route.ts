import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { RuntimeClient } from "@/lib/runtime-client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, sessionId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = RuntimeClient.for(agent);
  if (!client) return NextResponse.json({ error: "Агент не запущен" }, { status: 409 });
  return NextResponse.json({ actions: await client.browserActions(sessionId) });
}
