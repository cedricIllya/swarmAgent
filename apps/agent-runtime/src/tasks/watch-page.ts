import { createHash } from "node:crypto";
import { isMessengerRecipe, type Run, type ServiceCredential, type ServiceRecipe, type ServicesSnapshot } from "@swarm/contracts";
import { programmedChannel } from "../browser/access-mode";
import { credentialVariables } from "../browser/secrets";
import { warn } from "../core/log";
import type { AgentRuntime } from "../runtime";
import type { FoundTask } from "./found-tasks";

/**
 * Страница списка задач браузерного сервиса. Адрес лежит в доступе агента:
 * у разных аккаунтов разные доски. Плановая проверка открывает его сразу.
 * Поиск по меню остаётся только пока адреса нет.
 */

const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|signup|sign-up|register|forgot(?:-password)?|reset(?:-password)?|auth|oauth|sso)(?:\/|$)/i;
const MISSING_PATH = /(?:^|\/)(?:404|not-found|notfound)(?:\/|$)/i;
const TRACKING = /^(?:utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i;

export const TASK_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "key"],
        properties: {
          title: { type: "string", description: "Название задачи, как на странице" },
          detail: { type: "string", description: "Что сделать, если видно. Иначе пустая строка" },
          key: { type: "string", description: "Ключ карточки или ссылка на неё. Иначе пустая строка" },
        },
      },
    },
  },
} as const;

const EXTRACT_INSTRUCTION = [
  "Список задач на этой странице, назначенных текущему пользователю или упоминающих его.",
  "Только то, что видно. Нет таких задач — пустой список.",
  "title — название. detail — что сделать, если видно. key — ключ карточки или ссылка на неё, если видны. Не выдумывай.",
].join(" ");

const LOGIN_ACT = "введи %email% в поле почты, %password% в поле пароля и нажми Войти";

export interface SavedWatch {
  recipe: ServiceRecipe;
  cred: ServiceCredential;
  url: string;
}

export interface SavedCallWatch {
  recipe: ServiceRecipe;
  cred: ServiceCredential;
  call: NonNullable<ServiceCredential["tasksCall"]>;
}

function taskRecipes(services: ServicesSnapshot): ServiceRecipe[] {
  const connected = new Set(services.credentials.map((item) => item.slug));
  return services.recipes.filter((recipe) => recipe.watchesTasks === true && connected.has(recipe.slug) && !isMessengerRecipe(recipe));
}

/** Браузерный способ: ключа API или MCP нет, задачи смотрят на странице. */
export function usesBrowser(recipe: ServiceRecipe, cred: ServiceCredential | undefined): boolean {
  if (programmedChannel(recipe, cred) !== null) return false;
  return cred?.kind === "browser" || recipe.kind === "browser";
}

/** Сервисы с уже сохранённой страницей или вызовом runtime читает сам. Остальные — Hermes. */
export function splitTaskSurvey(services: ServicesSnapshot): { saved: SavedWatch[]; calls: SavedCallWatch[]; rest: ServiceRecipe[] } {
  const saved: SavedWatch[] = [];
  const calls: SavedCallWatch[] = [];
  const rest: ServiceRecipe[] = [];
  for (const recipe of taskRecipes(services)) {
    const cred = services.credentials.find((item) => item.slug === recipe.slug);
    const url = cred && usesBrowser(recipe, cred) ? canonicalTasksUrl(cred.tasksUrl ?? "", recipe.domains) : null;
    const call = cred ? savedTasksCall(recipe, cred) : null;
    if (cred && url) saved.push({ recipe, cred, url });
    else if (cred && call) calls.push({ recipe, cred, call });
    else rest.push(recipe);
  }
  return { saved, calls, rest };
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,119}$/;

/** Вызов списка, который можно повторять без модели. Чужой адрес и секрет в теле не проходят. */
export function savedTasksCall(recipe: ServiceRecipe, cred: ServiceCredential): NonNullable<ServiceCredential["tasksCall"]> | null {
  const call = cred.tasksCall;
  if (!call) return null;
  const channel = programmedChannel(recipe, cred);
  const token = cred.token || cred.oauth?.accessToken || "";
  if (channel === "api" && call.kind === "api" && call.url && (call.method === "GET" || call.method === "POST")) {
    if (!acceptableApiUrl(call.url, recipe, token)) return null;
    if (call.body && token.length >= 8 && call.body.includes(token)) return null;
    return call;
  }
  if (channel === "mcp" && call.kind === "mcp" && call.tool && TOOL_NAME.test(mcpToolName(recipe.slug, call.tool))) {
    const args = call.arguments ?? {};
    if (Array.isArray(args) || JSON.stringify(args).length > 4000) return null;
    if (token.length >= 8 && JSON.stringify(args).includes(token)) return null;
    return call;
  }
  return null;
}

/** Имя инструмента MCP без префикса Hermes `mcp_<slug>_`. */
export function mcpToolName(slug: string, tool: string): string {
  const prefix = `mcp_${slug}_`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

export function acceptableApiUrl(raw: string, recipe: ServiceRecipe, token = ""): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (token.length >= 8 && raw.includes(token)) return false;
  if (url.pathname.replace(/\/+$/, "").length === 0 && !url.search) return false;
  const host = url.hostname.toLowerCase();
  if (recipe.api?.baseUrl) {
    try {
      const base = new URL(recipe.api.baseUrl).hostname.toLowerCase();
      if (host === base || host.endsWith(`.${base}`) || base.endsWith(`.${host}`)) return true;
    } catch {
      /* домен рецепта ниже */
    }
  }
  return hostOnDomains(host, recipe.domains);
}

/** Отпечаток текста списка. Часы и «5 минут назад» не считаются изменением. */
export function pageDigest(text: string): string {
  const norm = text
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\d+\s*(?:секунд(?:у|ы)?|сек\.?|минут(?:у|ы)?|мин\.?|час(?:а|ов)?|дн(?:я|ей|ь)?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\s*(?:назад|ago)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex");
}

export async function saveWatch(
  rt: AgentRuntime,
  run: Run,
  cred: ServiceCredential,
  patch: Partial<Pick<ServiceCredential, "tasksUrl" | "tasksDigest" | "tasksCall">>,
): Promise<void> {
  if (!rt.services?.applyReport) return;
  await rt.services.applyReport({ type: "credential", credential: { ...cred, ...patch }, runId: run.id }, { quiet: true });
}

function hostOnDomains(host: string, domains: string[]): boolean {
  const name = host.toLowerCase();
  return domains.some((domain) => {
    const root = domain.toLowerCase().replace(/^\*\./, "").split("/")[0] ?? "";
    return root.length > 0 && (name === root || name.endsWith(`.${root}`));
  });
}

function cleanPath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

function isLoginPath(pathname: string): boolean {
  return LOGIN_PATH.test(cleanPath(pathname));
}

function isMissingPath(pathname: string): boolean {
  return MISSING_PATH.test(cleanPath(pathname));
}

/**
 * Адрес списка, который можно запомнить: https, домен сервиса, путь или фильтр,
 * не вход и не 404. Метки рекламы снимаются.
 */
export function canonicalTasksUrl(raw: string, domains: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!hostOnDomains(url.hostname, domains)) return null;
  url.hash = "";
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (TRACKING.test(key)) continue;
    kept.append(key, value);
  }
  kept.sort();
  url.search = kept.toString() ? `?${kept.toString()}` : "";
  url.pathname = cleanPath(url.pathname);
  if (isLoginPath(url.pathname) || isMissingPath(url.pathname)) return null;
  if (url.pathname === "/" && !url.search) return null;
  return url.toString();
}

export function isLoginUrl(raw: string, loginUrl?: string | null): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (isLoginPath(url.pathname)) return true;
  if (!loginUrl) return false;
  try {
    const login = new URL(loginUrl);
    const path = cleanPath(url.pathname);
    const expected = cleanPath(login.pathname);
    return url.hostname === login.hostname && path === expected && expected !== "/";
  } catch {
    return false;
  }
}

/** Открытый адрес — та же страница списка. Лишние параметры запроса не мешают. */
export function landedOnTasksPage(saved: string, landed: string, domains: string[]): boolean {
  const base = canonicalTasksUrl(saved, domains);
  const here = canonicalTasksUrl(landed, domains);
  if (!base || !here) return false;
  const a = new URL(base);
  const b = new URL(here);
  if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
  for (const [key, value] of a.searchParams) {
    if (b.searchParams.get(key) !== value) return false;
  }
  return true;
}

function isShortMissing(text: string): boolean {
  const head = text.replace(/\s+/g, " ").trim().slice(0, 180);
  if (head.length > 160) return false;
  return /404|page not found|страница не найдена|не найдена/i.test(head);
}

function textOf(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** null — со страницы не прочитался список. Пустой массив — список есть, задач нет. */
export function tasksFromExtract(data: unknown, service: string): FoundTask[] | null {
  const body = unwrap(data);
  if (!body || !Array.isArray(body.tasks)) return null;
  const out: FoundTask[] = [];
  for (const item of body.tasks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const title = textOf(rec.title, 120);
    if (!title) continue;
    const detail = textOf(rec.detail, 2000) || title;
    const key = textOf(rec.key, 200);
    out.push({ service, title, detail, ...(key ? { key } : {}) });
    if (out.length >= 8) break;
  }
  return out;
}

function unwrap(data: unknown): { tasks?: unknown } | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as { tasks?: unknown; data?: unknown };
  if (Array.isArray(rec.tasks)) return rec;
  if (rec.data && typeof rec.data === "object") return unwrap(rec.data);
  return rec;
}

export interface PageProbe {
  goto(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  act(instruction: string, variables?: Record<string, string>): Promise<{ success: boolean; message: string }>;
  extract(instruction: string, schema?: unknown): Promise<unknown>;
  read(): Promise<{ url: string; text: string }>;
}

export type PageRead = {
  tasks: FoundTask[] | null;
  ok: boolean;
  reason: "ok" | "login" | "other" | "shape" | "same";
  digest?: string;
};

/**
 * Один заход на сохранённую страницу. Вход — один шаг, затем снова этот адрес.
 * Другая страница, вход и 404 список не подтверждают: адрес из-за них не меняется.
 */
export async function readTasksPage(
  session: PageProbe,
  args: {
    tasksUrl: string;
    domains: string[];
    loginUrl?: string | null;
    service: string;
    variables?: Record<string, string>;
    navigate?: boolean;
    login?: boolean;
    previousDigest?: string;
  },
): Promise<PageRead> {
  if (args.navigate !== false) await session.goto(args.tasksUrl);
  let landed = await session.currentUrl();
  const blocked = () => isLoginUrl(landed, args.loginUrl) || !landedOnTasksPage(args.tasksUrl, landed, args.domains);
  if (blocked() && args.login !== false && args.variables?.email && args.variables.password && isLoginUrl(landed, args.loginUrl)) {
    await session.act(LOGIN_ACT, { email: args.variables.email, password: args.variables.password });
    await session.goto(args.tasksUrl);
    landed = await session.currentUrl();
  }
  if (isLoginUrl(landed, args.loginUrl)) return { tasks: [], ok: false, reason: "login" };
  if (!landedOnTasksPage(args.tasksUrl, landed, args.domains)) return { tasks: [], ok: false, reason: "other" };
  const reading = await session.read();
  let missingPath = false;
  try {
    missingPath = isMissingPath(new URL(reading.url).pathname);
  } catch {
    missingPath = false;
  }
  if (missingPath || isShortMissing(reading.text)) return { tasks: [], ok: false, reason: "other" };
  const digest = pageDigest(reading.text);
  if (args.previousDigest && args.previousDigest === digest) return { tasks: [], ok: true, reason: "same", digest };
  const tasks = tasksFromExtract(await session.extract(EXTRACT_INSTRUCTION, TASK_LIST_SCHEMA), args.service);
  if (!tasks) return { tasks: null, ok: false, reason: "shape", digest };
  return { tasks, ok: true, reason: "ok", digest };
}

/** Плановая проверка: открыть сохранённые страницы и вернуть задачи. Адрес не перезаписывает. */
export async function surveySavedPages(rt: AgentRuntime, run: Run): Promise<{ tasks: FoundTask[]; failed: number }> {
  const services = await rt.store.readServices();
  if (!services) return { tasks: [], failed: 0 };
  const { saved } = splitTaskSurvey(services);
  const tasks: FoundTask[] = [];
  let failed = 0;
  for (const item of saved) {
    if (await rt.isCanceled(run.id)) break;
    try {
      const found = await surveyOne(rt, run, item);
      tasks.push(...found);
    } catch (e) {
      failed += 1;
      warn("cron", "страница задач не прочитана", { slug: item.recipe.slug, error: String(e) });
      await rt.step(run.id, "error", `${item.recipe.name}: страница задач не прочитана`);
    }
  }
  return { tasks, failed };
}

async function surveyOne(rt: AgentRuntime, run: Run, item: SavedWatch): Promise<FoundTask[]> {
  const session = await rt.browser.open(run, {
    purpose: `задачи ${item.recipe.name}`,
    serviceSlug: item.recipe.slug,
    url: item.url,
  });
  try {
    const known = credentialVariables(item.cred);
    const read = await readTasksPage(session, {
      tasksUrl: item.url,
      domains: item.recipe.domains,
      service: item.recipe.slug,
      ...(item.recipe.browser?.loginUrl ? { loginUrl: item.recipe.browser.loginUrl } : {}),
      ...(known.email && known.password ? { variables: { email: known.email, password: known.password } } : {}),
      ...(item.cred.tasksDigest ? { previousDigest: item.cred.tasksDigest } : {}),
    });
    if (read.reason === "same") {
      await rt.step(run.id, "note", `${item.recipe.name}: список не изменился`);
      return [];
    }
    if (read.reason === "login") {
      await rt.step(run.id, "note", `${item.recipe.name}: страница входа, список не прочитан`);
      return [];
    }
    if (read.reason === "shape") {
      await rt.step(run.id, "note", `${item.recipe.name}: список на странице не прочитался, адрес не меняю`);
      return [];
    }
    if (read.reason === "other") {
      await rt.step(run.id, "note", `${item.recipe.name}: открылась другая страница, сохранённый адрес не меняю`);
      return [];
    }
    const n = read.tasks?.length ?? 0;
    await rt.step(run.id, "browser", n ? `${item.recipe.name}: список задач, найдено ${n}` : `${item.recipe.name}: список задач пуст`);
    if (read.digest && read.digest !== item.cred.tasksDigest) await saveWatch(rt, run, item.cred, { tasksDigest: read.digest });
    return read.tasks ?? [];
  } finally {
    await rt.browser.close(session.id).catch((e) => warn("cron", "браузер списка не закрылся", { error: String(e) }));
  }
}

export type RememberedPage =
  | { ok: true; saved: boolean; url?: string; tasks: FoundTask[] }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Первый заход Hermes на список. Адрес берётся с открытой вкладки и пишется один раз.
 * Вход, 404 и страница без списка адрес не получают. Уже записанный адрес не меняется.
 */
export async function rememberTasksPage(rt: AgentRuntime, run: Run, slug: string): Promise<RememberedPage> {
  const services = await rt.store.readServices();
  const recipe = services?.recipes.find((item) => item.slug === slug.trim());
  const cred = services?.credentials.find((item) => item.slug === slug.trim());
  if (!services || !recipe || !cred || !taskRecipes(services).some((item) => item.slug === recipe.slug)) {
    return { ok: false, status: 404, error: "сервис не подключён или не для задач" };
  }
  if (!usesBrowser(recipe, cred)) {
    return { ok: false, status: 409, error: `«${recipe.name}» читается через API или MCP, страница задач не нужна` };
  }
  const existing = canonicalTasksUrl(cred.tasksUrl ?? "", recipe.domains);
  if (existing) return { ok: true, saved: false, url: existing, tasks: [] };

  const session = [...rt.browser.sessions.values()].find((item) => item.serviceSlug === recipe.slug);
  if (!session) {
    return { ok: false, status: 409, error: "открой сервис в браузере и вызови снова со страницы списка" };
  }
  const current = canonicalTasksUrl(await session.currentUrl(), recipe.domains);
  if (!current || isLoginUrl(await session.currentUrl(), recipe.browser?.loginUrl)) {
    return { ok: false, status: 409, error: "это не страница списка задач: вход, корень сайта или другой домен. Адрес не сохранён" };
  }
  const read = await readTasksPage(session, {
    tasksUrl: current,
    domains: recipe.domains,
    service: recipe.slug,
    navigate: false,
    login: false,
    ...(recipe.browser?.loginUrl ? { loginUrl: recipe.browser.loginUrl } : {}),
  });
  if (!read.ok || !read.tasks) {
    return { ok: false, status: 409, error: "на странице нет списка задач, адрес не сохранён" };
  }
  await saveWatch(rt, run, cred, { tasksUrl: current, ...(read.digest ? { tasksDigest: read.digest } : {}) });
  await rt.step(run.id, "note", `${recipe.name}: страница задач ${current}`);
  return { ok: true, saved: true, url: current, tasks: read.tasks };
}
