import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgent, toAgentView, updateAgent } from "@swarm/agents";
import type { RuntimeState } from "@swarm/contracts";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { RuntimeClient } from "@/lib/runtime-client";
import { destroyAgent, reconfigureAgent } from "@/lib/create-agent";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  let state: RuntimeState | null = null;
  let runtimeError: string | null = null;
  const client = RuntimeClient.for(agent);
  if (client && agent.status === "running") {
    try {
      state = await client.state();
    } catch (e) {
      runtimeError = String(e instanceof Error ? e.message : e);
    }
  }
  return NextResponse.json({ agent: toAgentView(agent), state, runtimeError });
}

const Patch = z.object({
  autonomous: z.boolean().optional(),
  model: z.string().min(1).optional(),
  name: z.string().min(1).max(80).optional(),
});

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad input" }, { status: 400 });

  const patch: Parameters<typeof updateAgent>[2] = {};
  if (parsed.data.autonomous !== undefined) patch.autonomous = parsed.data.autonomous;
  if (parsed.data.model) patch.model = parsed.data.model;
  await updateAgent(db(), agent.id, patch);

  const client = RuntimeClient.for(agent);
  if (client && agent.status === "running") {
    try {
      await client.updateSettings({
        ...(parsed.data.autonomous !== undefined ? { autonomous: parsed.data.autonomous } : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
      });
    } catch (e) {
      console.warn(`[agents] runtime settings: ${String(e)}`);
    }
  }
  // Смена модели переписывает config.yaml Hermes и перезапускает машину.
  if (parsed.data.model && parsed.data.model !== agent.model) {
    reconfigureAgent(agent.id, viewer.user.email).catch((e) => console.warn(`[agents] reconfigure: ${String(e)}`));
  }

  const fresh = await getAgent(db(), viewer.tenant.id, id);
  return NextResponse.json({ agent: fresh ? toAgentView(fresh) : null });
}

export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await destroyAgent(agent);
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
