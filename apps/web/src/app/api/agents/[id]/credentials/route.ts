import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { listCredentials, listRecipes } from "@swarm/connections";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";

/** Вход, под которым агент сохранился в сервисе. Токен и cookies сюда не попадают. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [recipes, credentials] = await Promise.all([listRecipes(db()), listCredentials(db(), agent.id)]);
  const recipeOf = new Map(recipes.map((r) => [r.slug, r]));
  return NextResponse.json(
    credentials.map((c) => {
      const recipe = recipeOf.get(c.slug);
      return {
        slug: c.slug,
        name: recipe?.name ?? c.slug,
        kind: c.kind,
        accountEmail: c.accountEmail ?? null,
        accountName: c.accountName ?? null,
        password: c.password ?? null,
        watchesTasks: recipe?.watchesTasks ?? null,
      };
    }),
  );
}
