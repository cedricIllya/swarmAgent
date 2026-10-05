import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";

/** Кадр своего браузера. Runtime снаружи недоступен, картинка идёт через control plane. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sessionId: string; file: string }> },
): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, sessionId, file } = await params;
  if (!/^\d{1,3}\.jpg$/.test(file)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await awakeRuntime(agent, 120_000);
  if (!client) return NextResponse.json({ error: "Агент не запущен" }, { status: 409 });
  const upstream = await client.shot(sessionId, file);
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: "Кадра нет" }, { status: 404 });
  return new Response(upstream.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  });
}
