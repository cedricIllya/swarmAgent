import type { Agent, AgentStatus, UsageTotals } from "@swarm/contracts";
import { decryptString, encryptString, randomToken } from "@swarm/crypto";
import { and, desc, eq, isNull, lte, newId, or, schema, sql, type Db } from "@swarm/db";

type Row = typeof schema.agents.$inferSelect;

export function toAgentView(row: Row): Agent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    firstName: row.firstName,
    lastName: row.lastName,
    model: row.model,
    localPart: row.localPart,
    domain: row.domain,
    email: `${row.localPart}@${row.domain}`,
    status: row.status,
    statusMessage: row.statusMessage,
    autonomous: row.autonomous,
    flyAppName: row.flyAppName,
    flyMachineId: row.flyMachineId,
    runtimeUrl: row.runtimeUrl,
    googleConnected: Boolean(row.googleRefreshTokenEnc),
    googleEmail: row.googleRefreshTokenEnc ? row.googleEmail : null,
    avatar: row.avatar,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Строки целиком, с зашифрованными токенами: для вызовов в runtime. В браузер не отдавать. */
export async function listAgentRows(db: Db, tenantId: string): Promise<Row[]> {
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.tenantId, tenantId))
    .orderBy(desc(schema.agents.createdAt));
}

export async function listAgents(db: Db, tenantId: string): Promise<Agent[]> {
  return (await listAgentRows(db, tenantId)).map(toAgentView);
}

export async function getAgent(db: Db, tenantId: string, agentId: string): Promise<Row | null> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.tenantId, tenantId), eq(schema.agents.id, agentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAgentById(db: Db, agentId: string): Promise<Row | null> {
  const rows = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  return rows[0] ?? null;
}

/** Поиск владельца письма по голому адресу. */
export async function findAgentByAddress(db: Db, localPart: string, domain: string): Promise<Row | null> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.localPart, localPart.toLowerCase()), eq(schema.agents.domain, domain.toLowerCase())))
    .limit(1);
  return rows[0] ?? null;
}

export async function isAddressTaken(db: Db, localPart: string, domain: string): Promise<boolean> {
  return (await findAgentByAddress(db, localPart, domain)) !== null;
}

export interface NewAgentRecord {
  tenantId: string;
  name: string;
  firstName: string;
  lastName: string;
  model: string;
  localPart: string;
  domain: string;
}

/** Создаёт запись и токен для runtime. Токен хранится только зашифрованным. */
export async function insertAgent(db: Db, input: NewAgentRecord): Promise<{ row: Row; runtimeToken: string }> {
  const runtimeToken = randomToken(32);
  const id = newId("agt");
  const [row] = await db
    .insert(schema.agents)
    .values({
      id,
      tenantId: input.tenantId,
      name: input.name,
      firstName: input.firstName,
      lastName: input.lastName,
      model: input.model,
      localPart: input.localPart.toLowerCase(),
      domain: input.domain.toLowerCase(),
      status: "creating",
      runtimeTokenEnc: encryptString(runtimeToken),
    })
    .returning();
  if (!row) throw new Error("Не удалось создать агента");
  return { row, runtimeToken };
}

export async function updateAgent(
  db: Db,
  agentId: string,
  patch: Partial<{
    status: AgentStatus;
    statusMessage: string | null;
    autonomous: boolean;
    model: string;
    flyAppName: string | null;
    flyMachineId: string | null;
    flyVolumeId: string | null;
    runtimeUrl: string | null;
    runtimeRelease: string | null;
    googleRefreshToken: string | null;
    googleEmail: string | null;
    avatar: string | null;
  }>,
): Promise<void> {
  const { googleRefreshToken, ...rest } = patch;
  const values: Partial<typeof schema.agents.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (googleRefreshToken !== undefined) {
    values.googleRefreshTokenEnc = googleRefreshToken ? encryptString(googleRefreshToken) : null;
  }
  await db.update(schema.agents).set(values).where(eq(schema.agents.id, agentId));
}

/**
 * Запомнить итоги `usage.jsonl` агента. Журнал только растёт, поэтому отчёт,
 * пришедший позже, но снятый раньше (меньше токенов), сохранённый не затирает.
 */
export async function rememberAgentUsage(db: Db, agentId: string, totals: UsageTotals): Promise<void> {
  const tokens = totals.totalPromptTokens + totals.totalCompletionTokens;
  await db
    .update(schema.agents)
    .set({
      usageCostUsd: totals.totalCostUsd,
      usagePromptTokens: totals.totalPromptTokens,
      usageCompletionTokens: totals.totalCompletionTokens,
      usageAt: new Date(),
    })
    .where(
      and(
        eq(schema.agents.id, agentId),
        or(
          isNull(schema.agents.usagePromptTokens),
          lte(sql`${schema.agents.usagePromptTokens} + coalesce(${schema.agents.usageCompletionTokens}, 0)`, tokens),
        ),
      ),
    );
}

/** Когда будить агента на плановую проверку. `null` — снова каждые 15 минут. */
export async function rememberTickQuiet(db: Db, agentId: string, until: Date | null): Promise<void> {
  await db.update(schema.agents).set({ tickQuietUntil: until, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
}

export async function deleteAgent(db: Db, agentId: string): Promise<void> {
  await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
}

export function runtimeTokenOf(row: Row): string {
  if (!row.runtimeTokenEnc) throw new Error("У агента нет runtime token");
  return decryptString(row.runtimeTokenEnc);
}

export function googleRefreshTokenOf(row: Row): string | null {
  return row.googleRefreshTokenEnc ? decryptString(row.googleRefreshTokenEnc) : null;
}

export type AgentRow = Row;
