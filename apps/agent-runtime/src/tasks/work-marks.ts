/**
 * Метки одной и той же работы: ключ тикета, ссылка на карточку, название.
 * Письмо и плановая проверка ставят их на задачу, чтобы не начать её дважды.
 */

const TICKET = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{1,9}-\d{1,6})(?!\d)/g;
const DENY_PREFIX = new Set([
  "UTF",
  "ISO",
  "SHA",
  "RFC",
  "MD",
  "AES",
  "IEEE",
  "HTML",
  "HTTP",
  "HTTPS",
  "PDF",
  "PNG",
  "JPG",
  "GIF",
  "SVG",
  "CSS",
  "API",
]);

const HOST_NOISE = new Set(["www", "mail", "email", "notify", "notifications", "noreply", "app", "com", "org", "net", "io", "ru", "co"]);

/** Ключи тикетов и ссылки на конкретную карточку. Общий адрес сервиса сюда не входит. */
export function workMarks(parts: string[]): string[] {
  const text = parts.filter(Boolean).join("\n");
  const marks = new Set<string>();
  for (const match of text.matchAll(TICKET)) {
    const token = match[1]?.toUpperCase();
    if (!token) continue;
    const prefix = token.slice(0, token.indexOf("-"));
    if (DENY_PREFIX.has(prefix)) continue;
    marks.add(`ticket:${token}`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
    const url = canonicalUrl(match[0]);
    if (url) marks.add(url);
  }
  return [...marks];
}

/** Название без «Re:» и без префикса сервиса. Короткое название меткой не становится. */
export function titleMark(title: string, service: string | null): string | null {
  let text = title.replace(/\s+/g, " ").trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "");
  const prefixed = text.match(/^([A-Za-z0-9_-]{2,40}):\s+(.+)$/);
  let fromPrefix: string | null = null;
  if (prefixed?.[1] && prefixed[2]) {
    fromPrefix = prefixed[1];
    text = prefixed[2];
  }
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (words.length < 10) return null;
  const slug = normalizeService(service) ?? normalizeService(fromPrefix);
  return slug ? `title:${slug}:${words}` : `title:${words}`;
}

export function exactMark(title: string): string {
  return `exact:${title.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

export function normalizeService(service: string | null | undefined): string | null {
  if (!service) return null;
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return slug.length >= 2 ? slug : null;
}

/** Первая содержательная метка домена: linear.app → linear. */
export function serviceFromDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const host = domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  const label = host.split(".").find((part) => part.length >= 3 && !HOST_NOISE.has(part));
  return label ?? null;
}

/**
 * Явный ключ карточки. Число, uuid и хвост ссылки склеиваются:
 * `198035` и `https://host/tasks/198035` — одна метка.
 */
export function cardMark(service: string | null, key: string | null | undefined): string | null {
  if (!key) return null;
  const raw = key.replace(/\s+/g, " ").trim();
  if (raw.length < 3 || raw.length > 200) return null;
  let body = raw.toLowerCase();
  try {
    const url = new URL(raw);
    const segment = url.pathname.split("/").filter(Boolean).pop();
    if (segment && segment.length >= 3) body = decodeURIComponent(segment).toLowerCase();
  } catch {
    // не ссылка — метка из самого ключа
  }
  const slug = normalizeService(service) ?? "task";
  return `card:${slug}:${body}`;
}

/** `linear: Название` → linear. У плановой проверки и обычной фразы префикса нет. */
export function serviceFromTitle(title: string): string | null {
  const match = title.match(/^([A-Za-z0-9_-]{2,40}):\s+\S/);
  return normalizeService(match?.[1]);
}

function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/[),.;\]]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = url.pathname.replace(/\/+$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // путь остаётся как в ссылке
  }
  path = path.replace(/(\/(?:issues?|browse|pulls?|tasks?|cards?|tickets?|items?)\/[^/]+)(?:\/.*)?$/i, "$1");
  if (path.length < 2) return null;
  const full = `${host}${path}`.toLowerCase();
  const specific = /[a-z][a-z0-9]{1,9}-\d{1,6}/.test(full) || /\/(?:issues?|browse|pulls?|tasks?|cards?|tickets?|items?)\/[^/]+/.test(full);
  if (!specific) return null;
  return `url:${full}`;
}
