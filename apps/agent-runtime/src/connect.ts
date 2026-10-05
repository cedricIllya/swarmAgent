import { hostOf, rootDomain } from "./domains";

/**
 * Решение, можно ли назвать результат онбординга подключением.
 * Продуктов здесь нет: только факты прогона (домен, ключ, ответ API, пароль).
 */

/** Площадки, где соседи по суффиксу — чужие продукты. `acme.herokuapp.com` не сосед `evil.herokuapp.com`. */
const SHARED_SUFFIXES = new Set([
  "herokuapp.com",
  "github.io",
  "vercel.app",
  "netlify.app",
  "azurewebsites.net",
  "fly.dev",
  "onrender.com",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "pages.dev",
  "myshopify.com",
]);

export const BLOCKER_KINDS = [
  "captcha",
  "sso_only",
  "two_factor",
  "phone",
  "payment",
  "password_rejected",
  "email_rejected",
  "invite_spent",
  "other",
] as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export function blockerKind(raw: unknown): BlockerKind | null {
  return typeof raw === "string" && (BLOCKER_KINDS as readonly string[]).includes(raw) ? (raw as BlockerKind) : null;
}

/** Куда можно отправить ключ: домен приглашения и его поддомены, либо хост, который этот прогон сам видел. */
export function credentialHostAllowed(targetUrl: string, anchors: string[]): boolean {
  let target: string;
  try {
    target = hostOf(targetUrl);
  } catch {
    return false;
  }
  if (!target) return false;
  const targetRoot = rootDomain(target);
  const shared = SHARED_SUFFIXES.has(targetRoot);
  for (const anchor of anchors) {
    if (!anchor) continue;
    const host = anchor.includes("://") ? hostOf(anchor) : anchor.toLowerCase();
    if (!host) continue;
    if (shared) {
      if (target === host) return true;
      continue;
    }
    const root = rootDomain(host);
    if (target === host || target === root || target.endsWith(`.${root}`)) return true;
  }
  return false;
}

/** Настоящий ключ, а не маска, обрывок или текст со страницы. */
export function looksLikeApiKey(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") return { ok: false, reason: "пусто" };
  const v = value.trim();
  if (v.length < 16) return { ok: false, reason: "короче 16 символов" };
  if (/[•*…]|\.{3}/.test(v)) return { ok: false, reason: "похоже на маску" };
  if (/\s/.test(v)) return { ok: false, reason: "есть пробелы" };
  if (/[^\x20-\x7E]/.test(v)) return { ok: false, reason: "не ASCII" };
  return { ok: true, value: v };
}

export type Proof = "green" | "refused" | "inconclusive" | "not_tried";

export interface ProofResult {
  verdict: Proof;
  endpoint: string | null;
  detail: string;
}

function authHeader(name: string, token: string): Record<string, string> {
  if (/^authorization$/i.test(name)) {
    return { Authorization: /^(bearer|basic)\s/i.test(token) ? token : `Bearer ${token}` };
  }
  return { [name]: token };
}

/**
 * Ключ доказан, только если запрос с ним успешен, а тот же путь без него — нет.
 * Таймаут, 5xx и 429 — не опровержение.
 */
export async function proveApiKey(args: {
  urls: string[];
  headerName: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ProofResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const urls = args.urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 4);
  if (!urls.length || !args.headerName.trim() || !args.token) {
    return { verdict: "not_tried", endpoint: null, detail: "нет адреса или схемы, против которых пробовать" };
  }
  let sawRefused = false;
  let sawInconclusive = false;
  let lastDetail = "";
  for (const url of urls) {
    try {
      const withKey = await fetchImpl(url, {
        method: "GET",
        headers: authHeader(args.headerName, args.token),
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      });
      await withKey.body?.cancel().catch(() => undefined);
      if (withKey.status === 401 || withKey.status === 403) {
        sawRefused = true;
        lastDetail = `${url} ответил ${withKey.status} с ключом`;
        continue;
      }
      if (withKey.status === 404 || withKey.status === 405 || withKey.status === 410) {
        sawRefused = true;
        lastDetail = `${url} ответил ${withKey.status}: такого пути нет`;
        continue;
      }
      if (withKey.status >= 300) {
        sawInconclusive = true;
        lastDetail = `${url} ответил ${withKey.status}`;
        continue;
      }
      const bare = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000) });
      await bare.body?.cancel().catch(() => undefined);
      if (bare.status === 401 || bare.status === 403) {
        return { verdict: "green", endpoint: url, detail: `${url} открывается с ключом и закрыт без него (${bare.status})` };
      }
      lastDetail = `${url} отвечает ${bare.status} и без ключа`;
      sawInconclusive = true;
    } catch (e) {
      sawInconclusive = true;
      lastDetail = `${url}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (sawRefused && !sawInconclusive) return { verdict: "refused", endpoint: null, detail: lastDetail };
  if (sawInconclusive || sawRefused) return { verdict: "inconclusive", endpoint: null, detail: lastDetail };
  return { verdict: "not_tried", endpoint: null, detail: "нечего пробовать" };
}

export interface ConnectFacts {
  /** Чем кончился вход. `runtime` — сломался наш браузер, человеку в live view делать нечего. */
  onboard: "landed" | "blocked" | "failed" | "runtime";
  inviteUrl: string;
  landedUrl: string;
  /** Пароль печатали на странице (новый или сохранённый). */
  passwordTyped: boolean;
  password: string | null;
  barrierKind: BlockerKind | null;
  notes: string;
  apiBaseUrl: string | null;
  /** Схема названа и ключ прошёл проверку формата. Сам ключ сюда не кладём. */
  apiKeyUsable: boolean;
  proof: Proof;
  /** MCP ответил `initialize` и непустым `tools/list` без секрета или с этим ключом. */
  mcpReady: boolean;
}

export interface ConnectDecision {
  status: "ready" | "escalated" | "failed";
  mode: "mcp" | "api" | "browser" | null;
  reason: string;
  savePassword: boolean;
  saveToken: boolean;
  /** Закрыть сессию, которую открыли сами. Для эскалации — оставить. */
  closeBrowser: boolean;
}

export function decideConnection(f: ConnectFacts): ConnectDecision {
  if (f.onboard === "runtime") {
    return {
      status: "failed",
      mode: null,
      reason: f.notes || "браузерный рантайм не выполнил задачу",
      savePassword: false,
      saveToken: false,
      closeBrowser: true,
    };
  }

  if (f.onboard !== "landed") {
    const kind = f.barrierKind ? ` (${f.barrierKind})` : "";
    return {
      status: "escalated",
      mode: null,
      reason: f.notes || `вход не завершён${kind}`,
      savePassword: false,
      saveToken: false,
      // Истраченное приглашение человеку в браузере уже не починить.
      closeBrowser: f.barrierKind === "invite_spent",
    };
  }

  if (f.passwordTyped && f.landedUrl && !credentialHostAllowed(f.landedUrl, [f.inviteUrl])) {
    return {
      status: "escalated",
      mode: null,
      reason: "после входа страница оказалась на другом домене, пароль считаем засвеченным и ничего не сохраняем",
      savePassword: false,
      saveToken: false,
      closeBrowser: true,
    };
  }

  if (f.mcpReady) {
    return {
      status: "ready",
      mode: "mcp",
      reason: "MCP отвечает и отдаёт инструменты",
      savePassword: Boolean(f.password),
      saveToken: f.apiKeyUsable && f.proof === "green",
      closeBrowser: true,
    };
  }

  if (f.apiKeyUsable && f.proof === "green" && f.apiBaseUrl) {
    return {
      status: "ready",
      mode: "api",
      reason: "ключ доказан вызовом",
      savePassword: Boolean(f.password),
      saveToken: true,
      closeBrowser: true,
    };
  }

  if (f.password) {
    const gap = apiGap(f);
    return {
      status: "ready",
      mode: "browser",
      reason: gap ? `вход по паролю есть; ${gap}` : "вход по паролю есть, публичного API не нашли",
      savePassword: true,
      saveToken: false,
      closeBrowser: true,
    };
  }

  return {
    status: "escalated",
    mode: null,
    reason: apiGap(f) || "вошли без пароля, перелогиниться нечем и программный доступ не доказан",
    savePassword: false,
    saveToken: false,
    closeBrowser: false,
  };
}

function apiGap(f: ConnectFacts): string | null {
  if (f.apiKeyUsable && !f.apiBaseUrl) return "ключ создан, но базовый URL API не установлен";
  if (f.apiKeyUsable && f.proof === "refused") return "ключ создан, но вызов с ним отклонён";
  if (f.apiKeyUsable && f.proof === "inconclusive") return "ключ создан, но вызов не дал ни успеха, ни отказа";
  if (f.apiKeyUsable && f.proof === "not_tried") return "ключ создан, но проверять его было нечем";
  if (f.apiBaseUrl && !f.apiKeyUsable) return "API найден, ключ не создан";
  return null;
}

export const API_KEY_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    api_key: { type: "string" },
    key_page_url: { type: "string" },
    docs_url: { type: "string" },
    key_outcome: { type: "string", enum: ["created", "no_permission", "plan_gated", "no_api", "not_found"] },
    notes: { type: "string" },
  },
} as const;

/** Задача уже залогиненному браузеру: создать ключ. Продукт не называется способами, только адресом, если он известен. */
export function apiKeyPrompt(args: { agentName: string; keyPageUrl: string | null; feedback: string | null }): string {
  const where = args.keyPageUrl
    ? `Сначала открой ${args.keyPageUrl}. Если страницы нет или ключ там не создаётся — ищи в навигации.`
    : "Ищи в навигации.";
  return [
    "Ты уже вошёл в веб-продукт. Цель — создать новый API-ключ этого аккаунта.",
    where,
    "Смотри сайдбар, шестерёнку, меню аккаунта, настройки workspace, разделы Developers, API, Integrations, Tokens, Personal access tokens, Apps.",
    "Если в интерфейсе ключа нет — открой документацию этого же продукта и возьми оттуда адрес страницы ключа.",
    `Имя ключа — «${args.agentName}». Права — полный доступ, который этот аккаунт вправе выдать.`,
    "Существующие ключи замаскированы: не сообщай обрезанное значение. Нажми reveal или создай новый.",
    "Ничего другого не меняй, ничего не удаляй и не отзывай.",
    "found=false только после того, как посмотрел и интерфейс, и документацию.",
    args.feedback ? `Прошлая попытка отклонена: ${args.feedback}. Покажи ключ целиком или создай новый.` : "",
    "В любом случае закончи JSON-объектом. Ключ на экране, о котором не доложили, считается отсутствующим.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function readPagePrompt(): string {
  return [
    "Ничего не нажимай. Прочитай страницу, на которой стоишь, и верни API-ключ, если он виден целиком.",
    "Маскированное значение не возвращай. В любом случае закончи JSON-объектом.",
  ].join("\n");
}

export interface ApiKeyExtraction {
  found: boolean;
  apiKey: string | null;
  rejectReason: string | null;
  keyPageUrl: string | null;
  docsUrl: string | null;
  outcome: string | null;
  notes: string;
}

export function interpretApiKeyOutput(output: unknown): ApiKeyExtraction {
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const notes = typeof o.notes === "string" ? o.notes.trim().slice(0, 400) : "";
  const keyPageUrl = typeof o.key_page_url === "string" ? o.key_page_url : null;
  const docsUrl = typeof o.docs_url === "string" ? o.docs_url : null;
  const outcome = typeof o.key_outcome === "string" ? o.key_outcome : null;
  const raw = typeof o.api_key === "string" ? o.api_key : "";
  if (!raw.trim()) return { found: false, apiKey: null, rejectReason: null, keyPageUrl, docsUrl, outcome, notes };
  const check = looksLikeApiKey(raw);
  if (!check.ok) return { found: false, apiKey: null, rejectReason: check.reason, keyPageUrl, docsUrl, outcome, notes };
  return { found: true, apiKey: check.value, rejectReason: null, keyPageUrl, docsUrl, outcome, notes };
}
