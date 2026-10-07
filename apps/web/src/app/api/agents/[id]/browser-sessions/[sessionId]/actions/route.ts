import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, sessionId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await awakeRuntime(agent);
  if (!client) return NextResponse.json({ error: t("errors.agentNotRunning") }, { status: 409 });
  return NextResponse.json({ actions: await client.browserActions(sessionId) });
}
