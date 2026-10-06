import type { Run, RuntimeReport, ServiceRecipe, ServicesSnapshot } from "@swarm/contracts";
import { hostOf, isNoiseDomain, rootDomain, sameBrand } from "./domains";
import { fetchPage, type FetchedPage } from "./discovery/pages";
import { warn } from "./log";
import type { OpenRouterClient, WebCitation } from "./openrouter";
import type { Store } from "./store";
import { recordUsage, type TaskRef } from "./usage";

/**
 * Карта работы в браузерном сервисе. Пишется в заметки рецепта один раз,
 * дальше её видит каждый ход: системная подсказка печатает notes.
 */
export const WORK_GUIDE_MARK = "Как работать:";

const UNKNOWN_GUIDE =
  "Как работать: публичная документация не описала, где лежат назначенные задачи. Смотри страницу сервиса.";

const GUIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objects", "myWork", "actions", "avoid"],
  properties: {
    objects: { type: "string", description: "Как называются рабочие объекты: доска, задача, сообщение" },
    myWork: { type: "string", description: "Где лежит работа, назначенная текущему пользователю, и как туда попасть" },
    actions: { type: "string", description: "Обычные действия: открыть, ответить, сменить статус" },
    avoid: { type: "string", description: "Чего не делать: оплата, участники, удаление пространства" },
  },
} as const;

const ASSET_PATH = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|mp4|pdf)(\?|$)/i;
const WEAK_LABELS = new Set(["docs", "help", "app", "mail", "www", "api", "blog", "support"]);
const RETRY_MS = 15 * 60 * 1000;

/** Сбой поиска не пишем в рецепт: повторим не раньше чем через 15 минут. */
const failedAt = new Map<string, number>();
/** Два хода одновременно не читают одну и ту же документацию дважды. */
const inflight = new Map<string, Promise<void>>();

export function hasWorkGuide(notes: string): boolean {
  return notes.includes(WORK_GUIDE_MARK);
}

export interface WorkGuideFields {
  objects: string;
  myWork: string;
  actions: string;
  avoid: string;
}

function clip(value: string, max = 160): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Одна строка в заметки. Пустые объекты и «где моя работа» — карты нет. */
export function formatWorkGuide(fields: WorkGuideFields): string | null {
  const objects = clip(fields.objects);
  const myWork = clip(fields.myWork);
  if (!objects && !myWork) return null;
  const parts = [WORK_GUIDE_MARK];
  if (objects) parts.push(`объекты — ${objects}.`);
  if (myWork) parts.push(`Назначенное мне — ${myWork}.`);
  const actions = clip(fields.actions);
  const avoid = clip(fields.avoid);
  if (actions) parts.push(`Действия — ${actions}.`);
  if (avoid) parts.push(`Не трогать — ${avoid}.`);
  return parts.join(" ").slice(0, 500);
}

/** Дописывает карту к уже известному способу входа и не затирает её повторно. */
export function appendWorkGuide(notes: string, guide: string): string {
  if (hasWorkGuide(notes)) return notes;
  const block = guide.trim().slice(0, 500);
  if (!block) return notes;
  const prior = notes.trim();
  if (!prior) return block;
  return `${prior} ${block}`.slice(0, 1200);
}

/** Страница про работу в продукте, а не про API, ключ или MCP. */
export function scoreHelpUrl(raw: string): number {
  let path = "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
    path = `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return 0;
  }
  if (ASSET_PATH.test(path)) return 0;
  if (/openapi|swagger|graphql|\/mcp\b|api-reference|\/api\/|api[-_]?key|\/tokens?\b|\/auth\b|pricing|changelog|\/blog\b/.test(path)) return 0;
  if (/getting[-_]?started|quick[-_]?start|quickstart/.test(path)) return 80;
  if (/assigned|my[-_]?work|inbox|\/tasks?\b|notifications?/.test(path)) return 70;
  if (/how-to|howto|tutorial|user-guide|\/guide\b|help-center|\/help\b/.test(path)) return 60;
  if (/\/docs\b|\/support\b|\/learn\b/.test(path)) return 25;
  return 0;
}

function onService(url: string, domain: string): boolean {
  const host = hostOf(url);
  if (!host || isNoiseDomain(host)) return false;
  if (sameBrand(host, domain)) return true;
  const label = rootDomain(domain).split(".")[0] ?? "";
  return label.length >= 4 && !WEAK_LABELS.has(label) && host.split(".").includes(label);
}

/** До двух страниц документации этого сервиса, сначала про задачи и начало работы. */
export function pickHelpUrls(citations: Array<{ url: string }>, domain: string): string[] {
  const ranked = citations
    .map((citation) => ({ url: citation.url, score: onService(citation.url, domain) ? scoreHelpUrl(citation.url) : 0 }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of ranked) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item.url);
    if (out.length === 2) break;
  }
  return out;
}

export function helpFallbackUrls(domain: string): string[] {
  return [`https://help.${domain}/`, `https://${domain}/help`, `https://support.${domain}/`];
}

function parseGuide(text: string): WorkGuideFields {
  try {
    const raw = JSON.parse(text) as Partial<Record<keyof WorkGuideFields, unknown>>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { objects: str(raw.objects), myWork: str(raw.myWork), actions: str(raw.actions), avoid: str(raw.avoid) };
  } catch {
    return { objects: "", myWork: "", actions: "", avoid: "" };
  }
}

export interface GuideDeps {
  openRouter: OpenRouterClient | null;
  model: string;
  fetchImpl?: typeof fetch;
  onUsage?: (action: string, r: { model: string; promptTokens: number; completionTokens: number; costUsd: number }) => Promise<void> | void;
}

export type GuideOutcome = { status: "ready"; text: string } | { status: "unknown" } | { status: "skipped" };

function searchPrompt(service: string, domain: string): string {
  return [
    `Официальная документация сервиса «${service}» (${domain}): как в нём работать человеку.`,
    "Нужны getting started, help или руководство: как называются задачи, где пользователь видит назначенную ему работу.",
    "Не API, не MCP и не страница ключей. Верни короткий ответ со ссылками на источники.",
  ].join(" ");
}

function extractPrompt(service: string, domain: string, pages: Array<{ url: string; title: string; text: string }>): string {
  const body = pages.map((page) => `### ${page.title || page.url}\nURL: ${page.url}\n${page.text}`).join("\n\n");
  return [
    `Сервис «${service}» (${domain}). Ниже страницы о том, как в нём работать.`,
    "Извлеки короткую карту для агента, который ходит по интерфейсу:",
    "objects — как называются рабочие объекты; myWork — где лежит назначенная текущему пользователю работа и как туда попасть;",
    "actions — обычные действия; avoid — чего не делать (оплата, участники, удаление пространства).",
    "Только то, что есть в тексте. Нет в тексте — пустая строка. Без секретов. Верни JSON.",
    "",
    body,
  ].join("\n");
}

async function readHelpPages(
  urls: string[],
  citations: WebCitation[],
  fetchImpl: typeof fetch,
): Promise<Array<{ url: string; title: string; text: string }>> {
  const pages: Array<{ url: string; title: string; text: string }> = [];
  for (const url of urls) {
    const fetched: FetchedPage | null = await fetchPage(url, fetchImpl, 6_000);
    if (fetched && fetched.status < 300 && fetched.text.length > 80) {
      pages.push({ url: fetched.finalUrl, title: fetched.title, text: fetched.text });
      continue;
    }
    const cited = citations.find((citation) => citation.url === url);
    const excerpt = cited?.content.replace(/\s+/g, " ").trim() ?? "";
    if (excerpt.length > 80) pages.push({ url, title: cited?.title ?? "", text: excerpt.slice(0, 6_000) });
  }
  return pages;
}

/**
 * Один поиск и до двух страниц. `unknown` — смотрели, карты нет.
 * `skipped` — поиска не было, заметку не пишем.
 */
export async function learnWorkGuide(service: string, domain: string | null, deps: GuideDeps): Promise<GuideOutcome> {
  if (!deps.openRouter || !domain) return { status: "skipped" };
  const fetchImpl = deps.fetchImpl ?? fetch;
  let citations: WebCitation[] = [];
  try {
    const searched = await deps.openRouter.chat(
      [{ role: "user", content: searchPrompt(service, domain) }],
      { temperature: 0, maxTokens: 400, webSearch: { maxResults: 5 } },
      deps.model,
    );
    await deps.onUsage?.("guide.search", searched);
    citations = searched.citations;
  } catch (e) {
    warn("guide", "поиск документации не удался", { error: String(e) });
    return { status: "skipped" };
  }

  let urls = pickHelpUrls(citations, domain);
  if (!urls.length) {
    for (const url of helpFallbackUrls(domain)) {
      const page = await fetchPage(url, fetchImpl, 500);
      if (page && page.status < 300 && page.text.length > 80) {
        urls = [page.finalUrl];
        break;
      }
    }
  }
  const pages = await readHelpPages(urls, citations, fetchImpl);
  if (!pages.length) return { status: "unknown" };

  try {
    const extracted = await deps.openRouter.chat(
      [{ role: "user", content: extractPrompt(service, domain, pages) }],
      { jsonSchema: { name: "work_guide", schema: GUIDE_SCHEMA }, temperature: 0, maxTokens: 500 },
      deps.model,
    );
    await deps.onUsage?.("guide.extract", extracted);
    const text = formatWorkGuide(parseGuide(extracted.text));
    return text ? { status: "ready", text } : { status: "unknown" };
  } catch (e) {
    warn("guide", "карта сервиса не извлечена", { error: String(e) });
    return { status: "skipped" };
  }
}

export interface WorkGuideHost {
  model: string;
  openRouter: OpenRouterClient;
  store: Store;
  services: { applyReport(input: RuntimeReport, opts?: { quiet?: boolean }): Promise<unknown> };
  step(runId: string, kind: "note", text: string): Promise<unknown>;
  taskRef(run: Run): TaskRef;
}

function cooledDown(slug: string): boolean {
  const at = failedAt.get(slug);
  return at !== undefined && Date.now() - at < RETRY_MS;
}

/**
 * Перед ходом модели: у каждого подключённого браузерного сервиса без карты
 * один раз читаем публичную документацию и дописываем её в заметки рецепта.
 */
export async function ensureWorkGuides(host: WorkGuideHost, run: Run): Promise<void> {
  const snap: ServicesSnapshot | null = await host.store.readServices();
  if (!snap) return;
  for (const recipe of snap.recipes) {
    const cred = snap.credentials.find((c) => c.slug === recipe.slug);
    if (!cred || cred.kind !== "browser" || hasWorkGuide(recipe.notes) || cooledDown(recipe.slug)) continue;
    const pending = inflight.get(recipe.slug);
    if (pending) {
      await pending;
      continue;
    }
    const job = learnAndStore(host, run, recipe);
    inflight.set(recipe.slug, job);
    await job.finally(() => inflight.delete(recipe.slug));
  }
}

async function learnAndStore(host: WorkGuideHost, run: Run, recipe: ServiceRecipe): Promise<void> {
  try {
    const domain = recipe.domains.find((d) => d.includes(".")) ?? null;
    const outcome = await learnWorkGuide(recipe.name, domain, {
      openRouter: host.openRouter,
      model: host.model,
      onUsage: (action, r) => recordUsage(host.store, host.taskRef(run), action, "runtime", r),
    });
    if (outcome.status === "skipped") {
      failedAt.set(recipe.slug, Date.now());
      return;
    }
    const guide = outcome.status === "ready" ? outcome.text : UNKNOWN_GUIDE;
    const notes = appendWorkGuide(recipe.notes, guide);
    const next: ServiceRecipe = { ...recipe, notes };
    await host.services.applyReport({ type: "recipe", recipe: next, runId: run.id }, { quiet: true });
    recipe.notes = notes;
    await host.step(run.id, "note", `как работать в ${recipe.name}: ${guide}`.slice(0, 400));
  } catch (e) {
    failedAt.set(recipe.slug, Date.now());
    warn("guide", "карта сервиса не записана", { slug: recipe.slug, error: String(e) });
  }
}
