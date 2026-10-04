#!/usr/bin/env tsx
/**
 * Настройка приёма почты в Mailgun. Идемпотентно.
 *
 *   pnpm mailgun status   — что уже есть, DNS-записи для домена (ничего не меняет)
 *   pnpm mailgun domain   — создать receiving-домен, если его нет
 *   pnpm mailgun verify   — попросить Mailgun перепроверить DNS
 *   pnpm mailgun route    — создать/обновить Route: все письма домена → WEBHOOK_URL
 *
 * Читает MAILGUN_API_KEY, MAILGUN_REGION (us|eu), AGENTS_DOMAIN, WEBHOOK_URL.
 * Секреты не печатает.
 */

const cmd = process.argv[2] ?? "status";

function env(name: string, required = true): string {
  const v = process.env[name] ?? "";
  if (required && !v) {
    console.error(`Нет ${name}`);
    process.exit(1);
  }
  return v;
}

const apiKey = env("MAILGUN_API_KEY");
const region = (env("MAILGUN_REGION", false) || "eu").toLowerCase();
const domain = env("AGENTS_DOMAIN").toLowerCase();
const webhookUrl = env("WEBHOOK_URL", cmd === "route");
const base = region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
const auth = "Basic " + Buffer.from(`api:${apiKey}`).toString("base64");

async function mg<T>(method: string, path: string, form?: Record<string, string | string[]>): Promise<T> {
  const body = form ? new URLSearchParams() : undefined;
  if (form && body) {
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach((x) => body.append(k, x));
      else body.set(k, v);
    }
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: auth, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface DomainInfo {
  domain: { name: string; state: string; type: string; spam_action: string };
  receiving_dns_records: Array<{ record_type: string; valid: string; value: string; priority?: string; name?: string }>;
  sending_dns_records: Array<{ record_type: string; valid: string; value: string; name: string }>;
}

interface Route {
  id: string;
  expression: string;
  actions: string[];
  description: string;
}

async function getDomain(): Promise<DomainInfo | null> {
  try {
    return await mg<DomainInfo>("GET", `/v4/domains/${domain}`);
  } catch (e) {
    if (String(e).includes("404")) return null;
    throw e;
  }
}

function printDns(info: DomainInfo): void {
  console.log(`\nДомен ${info.domain.name}: state=${info.domain.state}, spam_action=${info.domain.spam_action}`);
  console.log("\nDNS для приёма (MX):");
  for (const r of info.receiving_dns_records) {
    console.log(`  ${r.valid.padEnd(8)} ${r.record_type}  ${domain}  ${r.priority ?? ""} ${r.value}`);
  }
  console.log("\nDNS для отправки (SPF/DKIM):");
  for (const r of info.sending_dns_records) {
    console.log(`  ${r.valid.padEnd(8)} ${r.record_type}  ${r.name}  ${r.value}`);
  }
  console.log("\nЗаписи ставятся у регистратора вручную. Этот скрипт DNS не меняет.");
}

function routeExpression(): string {
  return `match_recipient(".*@${domain.replace(/\./g, "\\.")}")`;
}

async function findRoute(): Promise<Route | null> {
  const res = await mg<{ items: Route[] }>("GET", "/v3/routes?limit=1000");
  const expr = routeExpression();
  return res.items.find((r) => r.expression === expr || r.description === `swarm:${domain}`) ?? null;
}

async function status(): Promise<void> {
  console.log(`Регион: ${region}, домен: ${domain}`);
  const info = await getDomain();
  if (!info) {
    console.log("Домен в Mailgun не создан. Запусти: pnpm mailgun domain");
  } else {
    printDns(info);
  }
  const route = await findRoute();
  if (!route) {
    console.log("\nRoute не создан. Запусти: pnpm mailgun route");
  } else {
    console.log(`\nRoute ${route.id}: ${route.expression}`);
    for (const a of route.actions) console.log(`  → ${a.replace(/https?:\/\/[^"']+/g, (u) => u.replace(/\/\/[^/]+/, "//<host>"))}`);
  }
}

async function ensureDomain(): Promise<void> {
  const existing = await getDomain();
  if (existing) {
    console.log("Домен уже есть.");
    printDns(existing);
    return;
  }
  // Спам: Tag, а не Block — письма с кодами и инвайтами не должны теряться.
  await mg("POST", "/v4/domains", { name: domain, spam_action: "tag", web_scheme: "https" });
  console.log("Домен создан.");
  const info = await getDomain();
  if (info) printDns(info);
}

async function verify(): Promise<void> {
  await mg("PUT", `/v4/domains/${domain}/verify`);
  const info = await getDomain();
  if (info) printDns(info);
}

async function ensureRoute(): Promise<void> {
  const actions = [`forward("${webhookUrl}")`, "stop()"];
  const existing = await findRoute();
  if (existing) {
    const same =
      existing.expression === routeExpression() &&
      existing.actions.length === actions.length &&
      existing.actions.every((a, i) => a === actions[i]);
    if (same) {
      console.log(`Route ${existing.id} уже настроен.`);
      return;
    }
    await mg("PUT", `/v3/routes/${existing.id}`, {
      priority: "0",
      expression: routeExpression(),
      action: actions,
      description: `swarm:${domain}`,
    });
    console.log(`Route ${existing.id} обновлён.`);
    return;
  }
  const res = await mg<{ route: Route }>("POST", "/v3/routes", {
    priority: "0",
    expression: routeExpression(),
    action: actions,
    description: `swarm:${domain}`,
  });
  console.log(`Route ${res.route.id} создан.`);
}

const commands: Record<string, () => Promise<void>> = { status, domain: ensureDomain, verify, route: ensureRoute };
const fn = commands[cmd];
if (!fn) {
  console.error(`Неизвестная команда: ${cmd}. Доступны: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
fn().catch((e) => {
  console.error(String(e).replace(apiKey, "***"));
  process.exit(1);
});
