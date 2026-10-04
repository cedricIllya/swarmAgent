import {
  ServiceCredentialSchema,
  ServiceRecipeSchema,
  type ServiceCredential,
  type ServiceRecipe,
  type ServicesSnapshot,
} from "@swarm/contracts";
import { decryptJson, encryptJson } from "@swarm/crypto";
import { and, eq, newId, schema, type Db } from "@swarm/db";

type RecipeRow = typeof schema.serviceRecipes.$inferSelect;

function rowToRecipe(row: RecipeRow): ServiceRecipe {
  return ServiceRecipeSchema.parse({
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    domains: row.domains,
    mcp: row.mcp ?? undefined,
    api: row.api ?? undefined,
    browser: row.browser ?? undefined,
    notes: row.notes,
    discoveredBy: row.discoveredByAgentId,
  });
}

/** Весь общий каталог. Он один на продукт, без фильтра по тенанту. */
export async function listRecipes(db: Db): Promise<ServiceRecipe[]> {
  const rows = await db.select().from(schema.serviceRecipes);
  return rows.map(rowToRecipe);
}

export async function getRecipe(db: Db, slug: string): Promise<ServiceRecipe | null> {
  const rows = await db.select().from(schema.serviceRecipes).where(eq(schema.serviceRecipes.slug, slug)).limit(1);
  return rows[0] ? rowToRecipe(rows[0]) : null;
}

/**
 * Рецепт пишет первый агент, встретивший сервис. Повторная запись
 * не понижает способ входа: mcp не затирается на browser.
 */
export async function upsertRecipe(db: Db, recipe: ServiceRecipe, discoveredByAgentId: string | null): Promise<void> {
  const parsed = ServiceRecipeSchema.parse(recipe);
  const existing = await getRecipe(db, parsed.slug);
  const rank = { mcp: 3, api: 2, browser: 1 } as const;
  if (existing && rank[existing.kind] > rank[parsed.kind]) {
    await db
      .update(schema.serviceRecipes)
      .set({
        domains: Array.from(new Set([...existing.domains, ...parsed.domains])),
        mcp: parsed.mcp ?? existing.mcp ?? null,
        api: parsed.api ?? existing.api ?? null,
        browser: parsed.browser ?? existing.browser ?? null,
        notes: existing.notes ? `${existing.notes}\n${parsed.notes}`.trim() : parsed.notes,
        updatedAt: new Date(),
      })
      .where(eq(schema.serviceRecipes.slug, parsed.slug));
    return;
  }
  await db
    .insert(schema.serviceRecipes)
    .values({
      slug: parsed.slug,
      name: parsed.name,
      kind: parsed.kind,
      domains: parsed.domains,
      mcp: parsed.mcp ?? null,
      api: parsed.api ?? null,
      browser: parsed.browser ?? null,
      notes: parsed.notes,
      discoveredByAgentId,
    })
    .onConflictDoUpdate({
      target: schema.serviceRecipes.slug,
      set: {
        name: parsed.name,
        kind: parsed.kind,
        domains: parsed.domains,
        mcp: parsed.mcp ?? null,
        api: parsed.api ?? null,
        browser: parsed.browser ?? null,
        notes: parsed.notes,
        updatedAt: new Date(),
      },
    });
}

/** Секреты тенанта. Тело расшифровывается только здесь, перед отправкой на машину. */
export async function listCredentials(db: Db, tenantId: string): Promise<ServiceCredential[]> {
  const rows = await db
    .select()
    .from(schema.serviceCredentials)
    .where(eq(schema.serviceCredentials.tenantId, tenantId));
  return rows.map((row) => {
    const body = decryptJson<Record<string, unknown>>(row.secretEnc);
    return ServiceCredentialSchema.parse({
      ...body,
      slug: row.slug,
      kind: row.kind,
      accountEmail: row.accountEmail ?? body["accountEmail"],
    });
  });
}

export async function upsertCredential(
  db: Db,
  tenantId: string,
  credential: ServiceCredential,
  connectedByAgentId: string | null,
): Promise<void> {
  const parsed = ServiceCredentialSchema.parse(credential);
  const { slug, kind, accountEmail, ...secret } = parsed;
  const secretEnc = encryptJson(secret);
  const existing = await db
    .select({ id: schema.serviceCredentials.id })
    .from(schema.serviceCredentials)
    .where(and(eq(schema.serviceCredentials.tenantId, tenantId), eq(schema.serviceCredentials.slug, slug)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(schema.serviceCredentials)
      .set({ kind, secretEnc, accountEmail: accountEmail ?? null, connectedByAgentId, updatedAt: new Date() })
      .where(eq(schema.serviceCredentials.id, existing[0].id));
    return;
  }
  await db.insert(schema.serviceCredentials).values({
    id: newId("crd"),
    tenantId,
    slug,
    kind,
    secretEnc,
    accountEmail: accountEmail ?? null,
    connectedByAgentId,
  });
}

export async function deleteCredential(db: Db, tenantId: string, slug: string): Promise<void> {
  await db
    .delete(schema.serviceCredentials)
    .where(and(eq(schema.serviceCredentials.tenantId, tenantId), eq(schema.serviceCredentials.slug, slug)));
}

/** Что уезжает на машину агента как `services.json`. */
export async function buildSnapshot(db: Db, tenantId: string): Promise<ServicesSnapshot> {
  const [recipes, credentials] = await Promise.all([listRecipes(db), listCredentials(db, tenantId)]);
  return { generatedAt: new Date().toISOString(), recipes, credentials };
}

/** Рецепт по домену отправителя письма или ссылки из инвайта. */
export function matchRecipeByDomain(recipes: ServiceRecipe[], hostOrEmail: string): ServiceRecipe | null {
  const host = hostOrEmail.includes("@") ? hostOrEmail.split("@").pop() ?? "" : hostOrEmail;
  const h = host.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  for (const r of recipes) {
    for (const d of r.domains) {
      const dd = d.toLowerCase();
      if (h === dd || h.endsWith(`.${dd}`)) return r;
    }
  }
  return null;
}
