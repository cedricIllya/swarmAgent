import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";

/** Проксирует ролик с машины агента: сам runtime снаружи недоступен. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, sessionId } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await awakeRuntime(agent, 120_000);
  if (!client) return NextResponse.json({ error: "Агент не запущен" }, { status: 409 });
  const upstream = await client.video(sessionId);
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: "Видео нет" }, { status: 404 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
