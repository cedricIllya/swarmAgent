import { after, NextResponse } from "next/server";
import { RuntimeReportSchema } from "@swarm/contracts";
import { upsertCredential, upsertRecipe } from "@swarm/connections";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { db } from "@/lib/db";
import { pushServicesToTenant } from "@/lib/create-agent";

/**
 * Агент нашёл способ входа (рецепт — общий на продукт) или вошёл в сервис
 * (доступ — только его тенанта). После записи остальные агенты тенанта получают snapshot.
 */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = RuntimeReportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad input" }, { status: 400 });

  if (parsed.data.type === "recipe") {
    await upsertRecipe(db(), parsed.data.recipe, agent.id);
  } else {
    await upsertCredential(db(), agent.tenantId, parsed.data.credential, agent.id);
  }
  after(() => pushServicesToTenant(agent.tenantId).catch((e) => console.warn(`[report] push: ${String(e)}`)));
  return NextResponse.json({ ok: true });
}
