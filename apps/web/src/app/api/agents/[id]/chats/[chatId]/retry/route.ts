import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; chatId: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, chatId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = z.object({ runId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const client = await awakeRuntime(agent);
  if (!client) return NextResponse.json({ error: t("errors.agentNotStarted") }, { status: 409 });
  try {
    const r = await client.retryChat(chatId, { runId: body.data.runId, author: viewer.user.email });
    return NextResponse.json(r, { status: 202 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.includes("→ 409")) {
      return NextResponse.json({ error: t("errors.otherTaskRunning") }, { status: 409 });
    }
    if (message.includes("→ 404")) {
      return NextResponse.json({ error: t("errors.taskNotRetryable") }, { status: 404 });
    }
    throw e;
  }
}
