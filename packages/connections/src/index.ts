import {
  ServiceCredentialSchema,
  ServiceRecipeSchema,
  type ServiceCredential,
  type ServiceRecipe,
  type ServicesSnapshot,
} from "@swarm/contracts";
import { decryptJson, encryptJson } from "@swarm/crypto";
import { and, desc, eq, newId, schema, type Db } from "@swarm/db";

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

/** Кому принадлежит доступ. Агент всегда внутри своего тенанта. */
export interface CredentialOwner {
  tenantId: string;
  agentId: string;
}

/** Секреты одного агента. Тело расшифровывается только здесь, перед отправкой на его машину. */
export async function listCredentials(db: Db, agentId: string): Promise<ServiceCredential[]> {
  const rows = await db
    .select()
    .from(schema.serviceCredentials)
    .where(eq(schema.serviceCredentials.agentId, agentId));
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

export async function upsertCredential(db: Db, owner: CredentialOwner, credential: ServiceCredential): Promise<void> {
  const parsed = ServiceCredentialSchema.parse(credential);
  const { slug, kind, accountEmail, ...secret } = parsed;
  const secretEnc = encryptJson(secret);
  await db
    .insert(schema.serviceCredentials)
    .values({
      id: newId("crd"),
      tenantId: owner.tenantId,
      agentId: owner.agentId,
      slug,
      kind,
      secretEnc,
      accountEmail: accountEmail ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.serviceCredentials.agentId, schema.serviceCredentials.slug],
      set: { kind, secretEnc, accountEmail: accountEmail ?? null, updatedAt: new Date() },
    });
}

export async function deleteCredential(db: Db, agentId: string, slug: string): Promise<void> {
  await db
    .delete(schema.serviceCredentials)
    .where(and(eq(schema.serviceCredentials.agentId, agentId), eq(schema.serviceCredentials.slug, slug)));
}

/** Один сохранённый доступ в сводке тенанта. Секрет сюда не попадает. */
export interface TenantConnectionAgent {
  agentId: string;
  agentName: string;
  agentEmail: string;
  kind: ServiceRecipe["kind"];
  accountEmail: string | null;
  updatedAt: string;
}

/** Сервис из каталога и агенты тенанта, у которых в него уже есть вход. */
export interface TenantConnection {
  slug: string;
  name: string;
  kind: ServiceRecipe["kind"];
  domains: string[];
  agents: TenantConnectionAgent[];
}

/**
 * Сводка по тенанту: какие сервисы подключены и через кого.
 * Секреты не расшифровываются — только метаданные для списка.
 */
export async function listTenantConnections(db: Db, tenantId: string): Promise<TenantConnection[]> {
  const rows = await db
    .select({
      slug: schema.serviceRecipes.slug,
      name: schema.serviceRecipes.name,
      recipeKind: schema.serviceRecipes.kind,
      domains: schema.serviceRecipes.domains,
      credentialKind: schema.serviceCredentials.kind,
      accountEmail: schema.serviceCredentials.accountEmail,
      updatedAt: schema.serviceCredentials.updatedAt,
      agentId: schema.agents.id,
      agentName: schema.agents.name,
      agentLocalPart: schema.agents.localPart,
      agentDomain: schema.agents.domain,
    })
    .from(schema.serviceCredentials)
    .innerJoin(schema.serviceRecipes, eq(schema.serviceRecipes.slug, schema.serviceCredentials.slug))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.serviceCredentials.agentId))
    .where(eq(schema.serviceCredentials.tenantId, tenantId))
    .orderBy(desc(schema.serviceCredentials.updatedAt));

  const bySlug = new Map<string, TenantConnection>();
  for (const row of rows) {
    let entry = bySlug.get(row.slug);
    if (!entry) {
      entry = { slug: row.slug, name: row.name, kind: row.recipeKind, domains: row.domains, agents: [] };
      bySlug.set(row.slug, entry);
    }
    entry.agents.push({
      agentId: row.agentId,
      agentName: row.agentName,
      agentEmail: `${row.agentLocalPart}@${row.agentDomain}`,
      kind: row.credentialKind,
      accountEmail: row.accountEmail,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** Агенты, у которых есть хотя бы один доступ. Остальным плановый тик смотреть нечего. */
export async function agentIdsWithCredentials(db: Db): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ agentId: schema.serviceCredentials.agentId })
    .from(schema.serviceCredentials);
  return new Set(rows.map((r) => r.agentId));
}

/**
 * Что уезжает на машину агента как `services.json`: весь общий каталог
 * и секреты только этого агента.
 */
export async function buildSnapshot(db: Db, agentId: string): Promise<ServicesSnapshot> {
  const [recipes, credentials] = await Promise.all([listRecipes(db), listCredentials(db, agentId)]);
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
