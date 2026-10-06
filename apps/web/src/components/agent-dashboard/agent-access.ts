export type AccessKind = "mcp" | "api" | "browser";

export interface AgentAccess {
  slug: string;
  name: string;
  kind: AccessKind;
  accountEmail: string | null;
  accountName: string | null;
  password: string | null;
  /** Есть ли назначенная работа. null — ещё не выяснили. */
  watchesTasks: boolean | null;
}

export interface LiveAccess {
  slug: string;
  name: string;
  kind: AccessKind;
  accountEmail?: string | null | undefined;
  accountName?: string | null | undefined;
  watchesTasks?: boolean | null | undefined;
}

export function accessKindLabel(kind: AccessKind): string {
  if (kind === "mcp") return "MCP";
  if (kind === "api") return "API";
  return "браузер";
}

/** Подпись тега: где агент смотрит задачи, а где нет. */
export function taskWatchLabel(watchesTasks: boolean | null | undefined): { text: string; title: string; ok: boolean } {
  if (watchesTasks === true) {
    return { text: "задачи", title: "Агент проверяет здесь назначенные задачи", ok: true };
  }
  if (watchesTasks === false) {
    return { text: "без задач", title: "Назначенной работы нет. Агент заходит только по прямой просьбе", ok: false };
  }
  return { text: "не ясно", title: "Ещё не выяснили, есть ли здесь назначенные задачи", ok: false };
}

function knownWatch(live: boolean | null | undefined, saved: boolean | null | undefined): boolean | null {
  if (typeof live === "boolean") return live;
  if (typeof saved === "boolean") return saved;
  return null;
}

/** Живой снимок машины и сохранённые доступы из базы. Пароль есть только в базе. */
export function mergeAccess(live: LiveAccess[], saved: AgentAccess[]): AgentAccess[] {
  const rows = new Map<string, AgentAccess>();
  for (const service of live) {
    const known = saved.find((item) => item.slug === service.slug);
    rows.set(service.slug, {
      slug: service.slug,
      name: service.name,
      kind: service.kind,
      accountEmail: known?.accountEmail ?? service.accountEmail ?? null,
      accountName: known?.accountName ?? service.accountName ?? null,
      password: known?.password ?? null,
      watchesTasks: knownWatch(service.watchesTasks, known?.watchesTasks),
    });
  }
  for (const item of saved) if (!rows.has(item.slug)) rows.set(item.slug, item);
  return [...rows.values()];
}
