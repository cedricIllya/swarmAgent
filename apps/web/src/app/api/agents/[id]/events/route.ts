import { getAgent } from "@swarm/agents";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { RuntimeClient } from "@/lib/runtime-client";
import { isAsleepState, isWakingState, machineState } from "@/lib/fly-machines";

export const dynamic = "force-dynamic";

const HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

/** Одно событие и пауза перед повтором. Машину не будим. */
function once(type: "asleep" | "waking" | "unreachable"): Response {
  const body = `event: ${type}\ndata: ${JSON.stringify({ type })}\nretry: 15000\n\n`;
  return new Response(body, { headers: HEADERS });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });

  const flyState = await machineState(agent).catch(() => null);
  if (isAsleepState(flyState)) return once("asleep");
  if (isWakingState(flyState)) return once("waking");

  const client = RuntimeClient.for(agent);
  if (!client || agent.status !== "running") return once("asleep");

  // Машина не спит, а поток не открылся: runtime завис. «Спит» здесь прятало бы, что агент не отвечает.
  let upstream: Response;
  try {
    upstream = await client.events(req.signal);
  } catch (e) {
    // #region agent log
    console.log(`[debug-105c57] events ${agent.id} unreachable fly=${flyState}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    // #endregion
    return once("unreachable");
  }
  if (!upstream.ok || !upstream.body) {
    // #region agent log
    console.log(`[debug-105c57] events ${agent.id} bad upstream fly=${flyState} http=${upstream.status}`);
    // #endregion
    return once("unreachable");
  }
  return new Response(upstream.body, { headers: HEADERS });
}
