import { getAgent, listAgents } from "@swarm/agents";
import { deleteTenant, listSoleMemberTenants, listTenantsForUser } from "@swarm/identity";
import { db } from "./db";
import { destroyAgent } from "./create-agent";

export interface DeletionPreview {
  /** Пространства, которые исчезнут вместе с аккаунтом. */
  tenants: Array<{ id: string; name: string; agents: number }>;
  /** Общие пространства: из них пользователь просто выйдет. */
  sharedTenants: Array<{ id: string; name: string }>;
}

/** Что именно пропадёт, если пользователь удалит аккаунт. Для страницы настроек. */
export async function previewAccountDeletion(userId: string): Promise<DeletionPreview> {
  const database = db();
  const [all, sole] = await Promise.all([listTenantsForUser(database, userId), listSoleMemberTenants(database, userId)]);
  const soleSet = new Set(sole);
  const tenants = await Promise.all(
    all
      .filter((t) => soleSet.has(t.id))
      .map(async (t) => ({ id: t.id, name: t.name, agents: (await listAgents(database, t.id)).length })),
  );
  return {
    tenants,
    sharedTenants: all.filter((t) => !soleSet.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
  };
}

/**
 * Снести всё, чем пользователь владеет единолично: личные пространства, агентов в них
 * вместе с машинами и дисками Fly, зашифрованные секреты. Вызывается до удаления записи user;
 * членство в общих пространствах уйдёт каскадом вместе с ней.
 *
 * Если хоть одну машину снести не удалось — бросаем, аккаунт остаётся: иначе платная машина
 * повиснет без хозяина. Агенты, которые успели удалиться, уже не вернутся — повтор это переживёт.
 */
export async function purgeUserSpaces(userId: string): Promise<void> {
  const database = db();
  const tenantIds = await listSoleMemberTenants(database, userId);

  for (const tenantId of tenantIds) {
    const agents = await listAgents(database, tenantId);
    const results = await Promise.allSettled(
      agents.map(async (a) => {
        const row = await getAgent(database, tenantId, a.id);
        if (row) await destroyAgent(row);
      }),
    );
    const failed = results
      .map((r, i) => ({ r, agent: agents[i] }))
      .filter((x): x is { r: PromiseRejectedResult; agent: (typeof agents)[number] } => x.r.status === "rejected");
    if (failed.length) {
      const details = failed
        .map((f) => `${f.agent?.name ?? "?"}: ${f.r.reason instanceof Error ? f.r.reason.message : String(f.r.reason)}`)
        .join("; ");
      throw new Error(`Не удалось удалить ${failed.length} из ${agents.length} агентов — ${details}`);
    }
    await deleteTenant(database, tenantId);
  }
}
