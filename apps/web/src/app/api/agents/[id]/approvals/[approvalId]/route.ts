import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, approvalId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = z
    .object({ approved: z.boolean().optional(), answer: z.string().max(8000).optional() })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const answer = body.data.answer?.trim() ?? "";
  if (!answer && typeof body.data.approved !== "boolean") return NextResponse.json({ error: "bad input" }, { status: 400 });
  const client = await awakeRuntime(agent);
  if (!client) return NextResponse.json({ error: t("errors.agentNotRunning") }, { status: 409 });
  return NextResponse.json(
    await client.resolveApproval(approvalId, answer ? { answer } : { approved: body.data.approved ?? false }),
  );
}
