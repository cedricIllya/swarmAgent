import { isInviteUrl } from "../tasks/invite-signal";
import { hostOf, rootDomain, sameBrand } from "./domains";

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
  "pending_approval",
  "other",
] as const;

/**
 * Сервис принял заявку, но аккаунт включит его администратор.
 * «Подтвердите почту» сюда не входит: код и ссылка приходят сразу.
 * «одобрение» (существительное) не совпадает — ждём «одобрена/одобрен».
 */
const PENDING_APPROVAL =
  /заявк\p{L}{0,12}.{0,48}одобр|одобр\p{L}{0,12}.{0,48}заявк|запрос\p{L}{0,12}.{0,40}регистрац|регистрац\p{L}{0,16}.{0,40}одобр|ожида\p{L}{0,12}.{0,24}одобрен|pending approval|awaiting approval|waiting for (an )?admin|registration request/iu;

const APPROVAL_GRANTED =
  /(^|[^\p{L}])одобрен[аоы]?(?!\p{L})|approved\b|account (is )?active|welcome to/iu;

export function looksLikeServiceApprovalWait(text: string): boolean {
  return PENDING_APPROVAL.test(text);
}

export function serviceApprovalGranted(text: string): boolean {
  return APPROVAL_GRANTED.test(text);
}

/** Письмо с того же сервиса, куда ушла заявка: домен отправителя или ссылка. */
export function mailTouchesHost(email: { from: string; links: string[] }, pageUrl: string): boolean {
  let root = "";
  try {
    root = rootDomain(hostOf(pageUrl));
  } catch {
    return false;
  }
  if (!root) return false;
  const from = email.from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1]?.toLowerCase() ?? "";
  if (from && sameBrand(from, root)) return true;
  return email.links.some((link) => {
    try {
      return sameBrand(hostOf(link), root);
    } catch {
      return false;
    }
  });
}

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

export interface ParsedAuth {
  headerName: string;
  /** Схема для `Authorization`. `null` — в заголовок кладётся сам ключ. */
  scheme: "Bearer" | "Basic" | "Token" | null;
}

function canonicalScheme(raw: string): "Bearer" | "Basic" | "Token" {
  if (/^basic$/i.test(raw)) return "Basic";
  if (/^token$/i.test(raw)) return "Token";
  return "Bearer";
}

/**
 * Документация часто пишет пример целиком: `Authorization: Bearer api_key`.
 * В запрос уходит только имя заголовка и схема, пример ключа отбрасывается.
 */
export function parseAuthScheme(raw: string): ParsedAuth | null {
  const text = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!text) return null;
  const colon = text.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/);
  if (colon) return authFromParts(colon[1]!, colon[2] ?? "");
  const spaced = text.match(/^(authorization)\s+(bearer|basic|token)\b/i);
  if (spaced) return { headerName: "Authorization", scheme: canonicalScheme(spaced[2]!) };
  if (/^(bearer|basic|token)$/i.test(text)) return { headerName: "Authorization", scheme: canonicalScheme(text) };
  if (/^authorization$/i.test(text)) return { headerName: "Authorization", scheme: "Bearer" };
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(text)) return { headerName: text, scheme: null };
  return null;
}

function authFromParts(name: string, rest: string): ParsedAuth | null {
  if (/^authorization$/i.test(name)) {
    const scheme = /^(bearer|basic|token)\b/i.exec(rest.trim());
    return { headerName: "Authorization", scheme: scheme ? canonicalScheme(scheme[1]!) : "Bearer" };
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) return null;
  return { headerName: name, scheme: null };
}

/** Имя заголовка для рецепта. Схема, если она не Bearer, остаётся в строке, чтобы вызов собрался так же. */
export function canonicalAuthHeader(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = parseAuthScheme(raw);
  if (!parsed) return null;
  if (parsed.scheme === "Basic") return "Authorization: Basic";
  if (parsed.scheme === "Token") return "Authorization: Token";
  return parsed.headerName;
}

export function recipeAuth(raw: string | null): { auth: "bearer" | "basic" | "header"; authHeader: string } {
  const parsed = raw ? parseAuthScheme(raw) : null;
  if (!parsed || parsed.scheme === "Bearer") return { auth: "bearer", authHeader: "Authorization" };
  if (parsed.scheme === "Basic") return { auth: "basic", authHeader: "Authorization" };
  return { auth: "header", authHeader: parsed.headerName };
}

function authHeader(raw: string, token: string): Record<string, string> | null {
  const parsed = parseAuthScheme(raw);
  if (!parsed) return null;
  if (!parsed.scheme) return { [parsed.headerName]: token };
  const value = new RegExp(`^${parsed.scheme}\\s`, "i").test(token) ? token : `${parsed.scheme} ${token}`;
  return { Authorization: value };
}

/** GET с путём. Корень хоста и шаблон вроде `/users/{id}` ключ не проверяют. */
export function isConcreteReadUrl(url: string): boolean {
  if (/[{}]|%7B|%7D/i.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (/\/:[A-Za-z]/.test(u.pathname)) return false;
    return u.pathname.replace(/\/+$/, "").length > 0;
  } catch {
    return false;
  }
}

/** Сначала GET из документации. База API — только если у неё самой есть путь. */
export function proofUrls(readEndpoints: string[], baseUrl: string | null): string[] {
  const fromDocs = readEndpoints.filter(isConcreteReadUrl).slice(0, 4);
  if (fromDocs.length) return fromDocs;
  if (baseUrl && isConcreteReadUrl(baseUrl)) return [baseUrl];
  return [];
}

/**
 * Проверка ключа идёт только по хосту сервиса. Найденный MCP `gensite.ru`
 * не доказывается запросом на `gitverse.ru`, даже если поиск так написал.
 */
export function proofUrlsForService(readEndpoints: string[], baseUrl: string | null, serviceUrls: string[]): string[] {
  const onService = (url: string) => credentialHostAllowed(url, serviceUrls);
  return proofUrls(
    readEndpoints.filter(onService),
    baseUrl && onService(baseUrl) ? baseUrl : null,
  );
}

/**
 * Ключ доказан, если запрос с ним вернул 2xx.
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
  const headers = authHeader(args.headerName, args.token);
  if (!urls.length || !headers || !args.token) {
    return { verdict: "not_tried", endpoint: null, detail: "нет адреса или схемы, против которых пробовать" };
  }
  let sawRefused = false;
  let sawInconclusive = false;
  let lastDetail = "";
  for (const url of urls) {
    try {
      const withKey = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      });
      await withKey.body?.cancel().catch(() => undefined);
      if (withKey.status >= 200 && withKey.status < 300) {
        return { verdict: "green", endpoint: url, detail: `${url} ответил ${withKey.status} с ключом` };
      }
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
      sawInconclusive = true;
      lastDetail = `${url} ответил ${withKey.status}`;
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
  /**
   * Заявка ушла администратору сервиса. Браузер закрываем, но в чате остаётся
   * карточка: человек одобряет заявку у себя, письмо сервиса или кнопка продолжают вход.
   */
  park: boolean;
}

/** Сбой нашего браузера. Человеку — без вендора, кода ответа и тела. Подробности остаются в логах. */
export const OWNER_OUTAGE = "Не получилось. Мы работаем над этим.";

export function decideConnection(f: ConnectFacts): ConnectDecision {
  if (f.onboard === "runtime") {
    return {
      status: "failed",
      mode: null,
      reason: OWNER_OUTAGE,
      savePassword: false,
      saveToken: false,
      closeBrowser: true,
      park: false,
    };
  }

  if (f.barrierKind === "pending_approval") {
    return {
      status: "escalated",
      mode: null,
      reason: f.notes || "заявка на регистрацию отправлена и ждёт одобрения в сервисе",
      savePassword: Boolean(f.password),
      saveToken: false,
      closeBrowser: true,
      park: true,
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
      park: false,
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
      park: false,
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
      park: false,
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
      park: false,
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
      park: false,
    };
  }

  return {
    status: "escalated",
    mode: null,
    reason: apiGap(f) || "вошли без пароля, перелогиниться нечем и программный доступ не доказан",
    savePassword: false,
    saveToken: false,
    closeBrowser: false,
    park: false,
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

/**
 * Адрес страницы, где токен уже выпустили, годится для следующего входа.
 * Корень сайта, вход, приглашение и длинный секрет в query не записываем.
 */
export function keyPageToStore(raw: string | null | undefined, anchors: string[]): string | null {
  if (!raw || !/^https:\/\//i.test(raw)) return null;
  if (!credentialHostAllowed(raw, anchors)) return null;
  if (isInviteUrl(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return null;
  if (/^\/(?:login|signin|sign-in|log-in|auth|register|signup|sign-up)\/?$/i.test(path)) return null;
  if (/^\/(?:docs|documentation|help|support)(?:\/|$)/i.test(path)) return null;
  if ([...url.searchParams.values()].some((value) => value.length > 24)) url.search = "";
  return url.toString();
}

/** Рецепт с записанной страницей токена. null — записывать нечего, адрес уже тот же. */
export function recipeWithKeyPage<
  T extends { browser?: { loginUrl: string; appUrl: string; keyPageUrl?: string | undefined } | undefined },
>(recipe: T, page: string): T | null {
  if (recipe.browser?.keyPageUrl === page) return null;
  let origin = "";
  try {
    origin = new URL(page).origin + "/";
  } catch {
    return null;
  }
  const browser = recipe.browser
    ? { ...recipe.browser, keyPageUrl: page }
    : { loginUrl: origin, appUrl: origin, keyPageUrl: page };
  return { ...recipe, browser };
}

/** Задача уже залогиненному браузеру: создать ключ. Продукт не называется способами, только адресом, если он известен. */
export function apiKeyPrompt(args: {
  agentName: string;
  keyPageUrl: string | null;
  /** Адрес уже подтверждён прошлым выпуском токена: открыть его, а не искать раздел. */
  remembered?: boolean;
  feedback: string | null;
  hint?: string | null;
}): string {
  const reportPage = "В key_page_url верни точный адрес страницы, на которой ключ создан или показан целиком.";
  if (args.remembered && args.keyPageUrl) {
    return [
      "Ты уже вошёл в веб-продукт. Цель — создать новый API-ключ этого аккаунта.",
      `Страница, где его выпускают, уже известна: открой ${args.keyPageUrl} и создай ключ там.`,
      "Другие разделы и документацию не открывай, пока эта страница не открылась или ключа на ней нет.",
      `Имя ключа — «${args.agentName}». Права — полный доступ, который этот аккаунт вправе выдать.`,
      "Существующие ключи замаскированы: не сообщай обрезанное значение. Нажми reveal или создай новый.",
      "Ничего другого не меняй, ничего не удаляй и не отзывай.",
      args.feedback ? `Прошлая попытка отклонена: ${args.feedback}. Покажи ключ целиком или создай новый.` : "",
      reportPage,
      "В любом случае закончи JSON-объектом. Ключ на экране, о котором не доложили, считается отсутствующим.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const where = args.keyPageUrl
    ? `Сначала открой ${args.keyPageUrl}. Если страницы нет или ключ там не создаётся — ищи в навигации.`
    : "Ищи в навигации.";
  const hint = args.hint?.trim() ? `Что известно об этом продукте: ${args.hint.trim().slice(0, 300)}` : "";
  return [
    "Ты уже вошёл в веб-продукт. Цель — создать новый API-ключ этого аккаунта.",
    hint,
    where,
    "Смотри сайдбар, шестерёнку, меню аккаунта, настройки workspace, разделы Developers, API, Integrations, Tokens, Personal access tokens, Apps.",
    "Если в интерфейсе ключа нет — открой документацию этого же продукта и возьми оттуда адрес страницы ключа.",
    `Имя ключа — «${args.agentName}». Права — полный доступ, который этот аккаунт вправе выдать.`,
    "Существующие ключи замаскированы: не сообщай обрезанное значение. Нажми reveal или создай новый.",
    "Ничего другого не меняй, ничего не удаляй и не отзывай.",
    "found=false только после того, как посмотрел и интерфейс, и документацию.",
    args.feedback ? `Прошлая попытка отклонена: ${args.feedback}. Покажи ключ целиком или создай новый.` : "",
    reportPage,
    "В любом случае закончи JSON-объектом. Ключ на экране, о котором не доложили, считается отсутствующим.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function readPagePrompt(): string {
  return [
    "Ничего не нажимай. Прочитай страницу, на которой стоишь, и верни API-ключ, если он виден целиком.",
    "В key_page_url верни адрес этой страницы.",
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
