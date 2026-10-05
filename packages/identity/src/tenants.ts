import { and, eq, inArray, schema, sql, type Db } from "@swarm/db";

export interface TenantView {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  agentsDomain: string | null;
}

export async function ensurePersonalTenant(
  db: Db,
  user: { id: string; name: string },
  newId: (prefix: string) => string,
): Promise<string> {
  const existing = await db
    .select({ id: schema.memberships.tenantId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const tenantId = newId("tnt");
  await db.transaction(async (tx) => {
    await tx.insert(schema.tenants).values({ id: tenantId, name: user.name || "Личное пространство" });
    await tx.insert(schema.memberships).values({
      id: newId("mem"),
      tenantId,
      userId: user.id,
      role: "owner",
    });
  });
  return tenantId;
}

export async function listTenantsForUser(db: Db, userId: string): Promise<TenantView[]> {
  const rows = await db
    .select({
      id: schema.tenants.id,
      name: schema.tenants.name,
      role: schema.memberships.role,
      agentsDomain: schema.tenants.agentsDomain,
    })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
    .where(eq(schema.memberships.userId, userId));
  return rows;
}

/** Активный тенант сессии или первый доступный. */
export async function resolveActiveTenant(
  db: Db,
  userId: string,
  preferredTenantId: string | null | undefined,
): Promise<TenantView | null> {
  const tenants = await listTenantsForUser(db, userId);
  if (preferredTenantId) {
    const hit = tenants.find((t) => t.id === preferredTenantId);
    if (hit) return hit;
  }
  return tenants[0] ?? null;
}

export async function assertMembership(db: Db, userId: string, tenantId: string): Promise<TenantView> {
  const rows = await db
    .select({
      id: schema.tenants.id,
      name: schema.tenants.name,
      role: schema.memberships.role,
      agentsDomain: schema.tenants.agentsDomain,
    })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.tenantId, tenantId)))
    .limit(1);
  const hit = rows[0];
  if (!hit) throw new Error("Нет доступа к тенанту");
  return hit;
}

/**
 * Тенанты, где пользователь — единственный участник. Уходит он — пространство
 * некому оставить, его сносим целиком. Общие тенанты не трогаем: оттуда человек просто выходит.
 */
export async function listSoleMemberTenants(db: Db, userId: string): Promise<string[]> {
  const mine = await db
    .select({ tenantId: schema.memberships.tenantId })
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId));
  if (mine.length === 0) return [];

  const counts = await db
    .select({ tenantId: schema.memberships.tenantId, members: sql<number>`count(*)::int` })
    .from(schema.memberships)
    .where(
      inArray(
        schema.memberships.tenantId,
        mine.map((m) => m.tenantId),
      ),
    )
    .groupBy(schema.memberships.tenantId);
  return counts.filter((c) => c.members === 1).map((c) => c.tenantId);
}

/** Каскадом уходят memberships, agents и service_credentials. */
export async function deleteTenant(db: Db, tenantId: string): Promise<void> {
  await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
}
