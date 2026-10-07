import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

async function agentOf(id: string) {
  const viewer = await getViewer();
  if (!viewer) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  return { agent };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const found = await agentOf(id);
  if ("error" in found && found.error) return found.error;
  const client = await awakeRuntime(found.agent!);
  if (!client) return NextResponse.json({ error: t("errors.agentNotStarted") }, { status: 409 });
  return NextResponse.json(await client.chats());
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const found = await agentOf(id);
  if ("error" in found && found.error) return found.error;
  const body = z.object({ title: z.string().optional() }).safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const client = await awakeRuntime(found.agent!);
  if (!client) return NextResponse.json({ error: t("errors.agentNotStarted") }, { status: 409 });
  const chat = await client.createChat(body.data.title);
  return NextResponse.json(chat, { status: 201 });
}
