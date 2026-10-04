import { and, eq, schema, type Db } from "@swarm/db";

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
