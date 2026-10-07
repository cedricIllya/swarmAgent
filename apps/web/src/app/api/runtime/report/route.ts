import { after, NextResponse } from "next/server";
import { messengerAdapter, RuntimeReportSchema, type ServiceCredential } from "@swarm/contracts";
import { findSlackInstall, getRecipe, upsertCredential, upsertRecipe } from "@swarm/connections";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { db } from "@/lib/db";
import { pushServicesToAgent, pushServicesToTenant } from "@/lib/create-agent";
import { slackAuth } from "@/lib/slack";

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
    const credential = await stampSlackUser(agent.id, parsed.data.credential);
    await upsertCredential(db(), { tenantId: agent.tenantId, agentId: agent.id }, credential);
    after(() => pushServicesToAgent(agent).catch((e) => console.warn(`[report] push: ${String(e)}`)));
  }
  return NextResponse.json({ ok: true });
}

/** Токен Slack без id пользователя. Узнаём его здесь, чтобы вебхук нашёл этого агента, а не всю команду. */
async function stampSlackUser(agentId: string, credential: ServiceCredential): Promise<ServiceCredential> {
  const token = credential.token || credential.oauth?.accessToken;
  if (!token) return credential;
  const recipe = await getRecipe(db(), credential.slug);
  if (!recipe || messengerAdapter(recipe) !== "slack") return credential;
  const auth = await slackAuth(token);
  if (!auth?.userId) return credential;
  const owner = await findSlackInstall(db(), auth.userId);
  if (owner && owner.agentId !== agentId) {
    console.warn(`[slack] пользователь ${auth.userId} уже подключён к ${owner.agentId}`);
    if (credential.externalKey !== auth.userId) return credential;
    const { externalKey: _taken, ...rest } = credential;
    return rest;
  }
  return { ...credential, externalKey: auth.userId };
}
