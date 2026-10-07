import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

async function clientFor(id: string) {
  const viewer = await getViewer();
  if (!viewer) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  const client = await awakeRuntime(agent);
  if (!client) return { error: NextResponse.json({ error: t("errors.agentNotStarted") }, { status: 409 }) };
  return { client };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; chatId: string }> }): Promise<Response> {
  const { id, chatId } = await params;
  const found = await clientFor(id);
  if ("error" in found && found.error) return found.error;
  return NextResponse.json(await found.client!.chatMessages(chatId));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; chatId: string }> }): Promise<Response> {
  const { id, chatId } = await params;
  const found = await clientFor(id);
  if ("error" in found && found.error) return found.error;
  const body = z.object({ title: z.string().min(1).max(80) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  return NextResponse.json(await found.client!.renameChat(chatId, body.data.title));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; chatId: string }> }): Promise<Response> {
  const { id, chatId } = await params;
  const found = await clientFor(id);
  if ("error" in found && found.error) return found.error;
  return NextResponse.json(await found.client!.deleteChat(chatId));
}
