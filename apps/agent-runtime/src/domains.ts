import type { ServiceRecipe } from "@swarm/contracts";

/** Домены почтовых рассылок, трекинга ссылок и соцсетей: по ним сервис не определить. */
const NOISE_DOMAINS = new Set([
  "sendgrid.net",
  "mailgun.org",
  "mailgun.net",
  "mandrillapp.com",
  "mailchimp.com",
  "list-manage.com",
  "mcusercontent.com",
  "hubspotlinks.com",
  "hubspot.com",
  "sparkpostmail.com",
  "amazonses.com",
  "customeriomail.com",
  "intercom-mail.com",
  "intercom.io",
  "postmarkapp.com",
  "mailtrack.io",
  "google.com",
  "googleapis.com",
  "gstatic.com",
  "goo.gl",
  "apple.com",
  "microsoft.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "github.io",
  "w3.org",
  "schema.org",
]);

/** Вторые уровни вроде `co.uk`, где корень домена — три метки. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne"]);

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  }
}

/** `mail.linear.app` → `linear.app`, `app.example.co.uk` → `example.co.uk`. */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return parts.slice(-take).join(".");
}

export function isNoiseDomain(domain: string): boolean {
  return NOISE_DOMAINS.has(rootDomain(domain));
}

/** Слишком общие первые метки, по которым нельзя считать `x.so` и `x.com` одним брендом. */
const GENERIC_LABELS = new Set(["mail", "docs", "www", "app", "api", "cloud", "blog", "shop", "news", "info", "test", "home", "team", "my", "get", "go", "web", "site"]);

/**
 * Один ли бренд: `notion.so` и `mcp.notion.com` — да, `mail.ru` и `mail.com` — нет.
 * Равные корни или одинаковая первая метка длиной от четырёх знаков, не из общих слов.
 */
export function sameBrand(a: string, b: string): boolean {
  const ra = rootDomain(a);
  const rb = rootDomain(b);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  const la = ra.split(".")[0] ?? "";
  const lb = rb.split(".")[0] ?? "";
  return la === lb && la.length >= 4 && !GENERIC_LABELS.has(la);
}

/**
 * Домен сервиса по подсказке классификатора и ссылкам из письма или чата.
 * Явный домен важнее; иначе — самый частый корневой домен среди ссылок без рассылочного шума.
 */
export function pickServiceDomain(hint: string | null, links: string[]): string | null {
  if (hint) {
    const root = rootDomain(hostOf(hint));
    if (root.includes(".") && !isNoiseDomain(root)) return root;
  }
  const counts = new Map<string, number>();
  for (const link of links) {
    const root = rootDomain(hostOf(link));
    if (!root.includes(".") || isNoiseDomain(root)) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

export function matchRecipe(recipes: ServiceRecipe[], hosts: string[]): ServiceRecipe | null {
  for (const host of hosts) {
    const h = host.toLowerCase();
    if (!h) continue;
    for (const recipe of recipes) {
      for (const domain of recipe.domains) {
        const d = domain.toLowerCase();
        if (h === d || h.endsWith(`.${d}`)) return recipe;
      }
    }
  }
  return null;
}

/** `linear.app` → `linear`; имя без домена → транслит-слаг из латиницы и цифр. */
export function slugFor(domain: string | null, service: string | null): string {
  const base = domain ? (domain.split(".")[0] ?? domain) : (service ?? "service");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "service";
}
