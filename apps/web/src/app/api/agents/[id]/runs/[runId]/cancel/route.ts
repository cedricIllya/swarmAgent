import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, runId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await awakeRuntime(agent);
  if (!client) return NextResponse.json({ error: t("errors.agentNotStarted") }, { status: 409 });
  try {
    const r = await client.cancelRun(runId);
    return NextResponse.json(r);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.includes("→ 404")) {
      return NextResponse.json({ error: t("errors.taskNotFound") }, { status: 404 });
    }
    if (message.includes("→ 409")) {
      return NextResponse.json({ error: t("errors.taskNotStoppable") }, { status: 409 });
    }
    throw e;
  }
}
