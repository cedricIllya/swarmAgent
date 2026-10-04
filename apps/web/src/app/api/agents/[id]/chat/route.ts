import { NextResponse } from "next/server";
import { ChatRequestSchema } from "@swarm/contracts";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { RuntimeClient } from "@/lib/runtime-client";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = ChatRequestSchema.pick({ message: true }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const client = RuntimeClient.for(agent);
  if (!client || agent.status !== "running") {
    return NextResponse.json({ error: "Агент ещё не запущен" }, { status: 409 });
  }
  const r = await client.chat({ message: body.data.message, author: viewer.user.email });
  return NextResponse.json(r, { status: 202 });
}
