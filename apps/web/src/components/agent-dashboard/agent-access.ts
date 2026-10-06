export type AccessKind = "mcp" | "api" | "browser";

export interface AgentAccess {
  slug: string;
  name: string;
  kind: AccessKind;
  accountEmail: string | null;
  accountName: string | null;
  password: string | null;
}

export interface LiveAccess {
  slug: string;
  name: string;
  kind: AccessKind;
  accountEmail?: string | null | undefined;
  accountName?: string | null | undefined;
}

export function accessKindLabel(kind: AccessKind): string {
  if (kind === "mcp") return "MCP";
  if (kind === "api") return "API";
  return "браузер";
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
    });
  }
  for (const item of saved) if (!rows.has(item.slug)) rows.set(item.slug, item);
  return [...rows.values()];
}
