import { after, NextResponse } from "next/server";
import { RuntimeReportSchema } from "@swarm/contracts";
import { upsertCredential, upsertRecipe } from "@swarm/connections";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { db } from "@/lib/db";
import { pushServicesToAgent, pushServicesToTenant } from "@/lib/create-agent";

/**
 * Агент нашёл способ входа (рецепт — общий на продукт) или вошёл в сервис
 * (доступ — только его). Рецепт разлетается агентам тенанта, доступ возвращается только автору.
 */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = RuntimeReportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad input" }, { status: 400 });

  if (parsed.data.type === "recipe") {
    await upsertRecipe(db(), parsed.data.recipe, agent.id);
    after(() => pushServicesToTenant(agent.tenantId).catch((e) => console.warn(`[report] push: ${String(e)}`)));
  } else {
    await upsertCredential(db(), { tenantId: agent.tenantId, agentId: agent.id }, parsed.data.credential);
    after(() => pushServicesToAgent(agent).catch((e) => console.warn(`[report] push: ${String(e)}`)));
  }
  return NextResponse.json({ ok: true });
}
