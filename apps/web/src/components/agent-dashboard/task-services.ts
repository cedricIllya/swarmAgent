export interface TaskService {
  slug: string;
  name: string;
  kind: "mcp" | "api" | "browser";
}

const KIND_BY_LABEL: Record<string, TaskService["kind"]> = {
  mcp: "mcp",
  api: "api",
  браузер: "browser",
};

const EXPLICIT = [
  /подключён сервис\s+(.+?)\s+\((MCP|API|браузер)\)/gi,
  /найден способ входа в\s+(.+?)\s+\((MCP|API|браузер)\)/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasToken(hay: string, token: string): boolean {
  if (token.length < 3) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(hay);
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Сервисы, которыми задача пользовалась: каталог, если имя или слаг есть в журнале,
 * плюс явные строки «подключён сервис» и «найден способ входа».
 */
export function servicesForRun(
  catalog: TaskService[],
  texts: string[],
): TaskService[] {
  const hay = texts.join("\n");
  const out: TaskService[] = [];
  const seen = new Set<string>();

  function add(service: TaskService) {
    const key = service.slug.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(service);
  }

  for (const service of catalog) {
    if (hasToken(hay, service.slug) || (service.name.toLowerCase() !== service.slug.toLowerCase() && hasToken(hay, service.name))) {
      add(service);
    }
  }

  for (const pattern of EXPLICIT) {
    pattern.lastIndex = 0;
    for (const match of hay.matchAll(pattern)) {
      const name = match[1]?.trim();
      const kind = KIND_BY_LABEL[(match[2] ?? "").toLowerCase()];
      if (!name || !kind || name.length < 2) continue;
      const known = catalog.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.slug.toLowerCase() === slugify(name));
      add(known ?? { slug: slugify(name), name, kind });
    }
  }

  return out;
}
