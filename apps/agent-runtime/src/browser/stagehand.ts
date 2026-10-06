import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import type { BrowserSession } from "@swarm/contracts";
import type { OpenRouterClient, ChatMessageIn } from "../openrouter";
import type { Store } from "../store";
import { recordUsage, type TaskRef } from "../usage";
import { log, warn } from "../log";
import { toExtractSchema } from "./schema";
import { shotFile } from "./shots";
import { acquireProfile } from "./profile-lock";
import { maskVariables } from "./secrets";
import type { BrowserStorageState } from "./session-transfer";

type LLMContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type LLMGenerateParams = {
  messages: Array<{ role: "user" | "assistant"; content: LLMContentBlock | LLMContentBlock[] }>;
  systemPrompt?: string;
  temperature?: number;
  responseFormat?: { type: "text" } | { type: "json_schema"; name: string; schema: unknown };
};

export interface BrowserDeps {
  openRouter: OpenRouterClient;
  model: string;
  store: Store;
}

type LocalBrowserHandle = Awaited<ReturnType<typeof localBrowser.launch>>;

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;
/** Один шаг Stagehand: модель плюс действие на странице. Зависший шаг не держит задачу вечно. */
const STEP_TIMEOUT_MS = 2 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 10 * 1000;
/** SPA после domcontentloaded ещё белая: ждём затишья сети и первого текста, но не дольше этого. */
const SETTLE_MS = 8 * 1000;
const TEXT_POLL_MS = 400;

type SettlePage = {
  waitForLoadState(state: "load" | "domcontentloaded" | "networkidle", timeout?: number): Promise<void>;
  evaluate<R>(expression: string): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
};

/** Есть ли на странице хоть какой-то текст. Ошибка оценки — считаем, что есть: ждать дальше нечего. */
async function hasVisibleText(page: SettlePage): Promise<boolean> {
  return page.evaluate<boolean>("(document.body && document.body.innerText || '').trim().length > 0").catch(() => true);
}

export interface PageReading {
  url: string;
  /** Видимый текст страницы, до READ_TEXT_MAX символов. */
  text: string;
  /** Значения input/textarea с подписью: сюда сервисы кладут выпущенные ключи. */
  fields: Array<{ label: string; value: string }>;
  /** Похожие на ключ или токен строки из текста и полей, точно как на странице. */
  tokens: string[];
}

const READ_TEXT_MAX = 20_000;
const READ_FIELD_MAX = 4_000;

/** Выполняется в странице: текст и поля формы, пароли не читаем. */
const PAGE_READ_SCRIPT = `(() => {
  const text = (document.body && document.body.innerText) || "";
  const fields = [];
  for (const el of document.querySelectorAll("input, textarea")) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
    const value = typeof el.value === "string" ? el.value : "";
    if (!value.trim()) continue;
    const labelEl = el.id ? document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]') : null;
    const label = (labelEl && labelEl.textContent) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || el.tagName.toLowerCase();
    fields.push({ label: String(label).trim().slice(0, 80), value: value.slice(0, ${READ_FIELD_MAX}) });
  }
  return { text: text.slice(0, ${READ_TEXT_MAX}), fields };
})()`;

/** Строки, похожие на выпущенный ключ: длинные, без пробелов, не адреса и не слова. */
export function tokenCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._~+\/=-]{19,}/g)) {
    const s = m[0].replace(/[.,;:)]+$/, "");
    if (s.length < 20) continue;
    if (/^https?:|^www\.|@|\.(com|ru|io|app|org|net|dev)(\/|$)/i.test(s)) continue;
    if (!/\d/.test(s) && !/[._-]/.test(s)) continue;
    out.add(s);
  }
  return [...out];
}

export function pageReading(url: string, text: string, fields: Array<{ label: string; value: string }>): PageReading {
  const tokens = new Set<string>();
  for (const f of fields) for (const t of tokenCandidates(f.value)) tokens.add(t);
  for (const t of tokenCandidates(text)) tokens.add(t);
  return { url, text, fields, tokens: [...tokens] };
}

export async function settlePage(page: SettlePage, opts: { network: boolean; budgetMs?: number }): Promise<void> {
  const budget = opts.budgetMs ?? SETTLE_MS;
  const until = Date.now() + budget;
  if (opts.network) await page.waitForLoadState("networkidle", budget).catch(() => undefined);
  while (!(await hasVisibleText(page))) {
    if (Date.now() >= until) return;
    await page.waitForTimeout(TEXT_POLL_MS);
  }
}

async function withTimeout<T>(what: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: шаг браузера не завершился за ${Math.round(ms / 1000)} с`)), ms);
  });
  try {
    return await Promise.race([p, bomb]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cachedUserAgent: string | null | undefined;

/**
 * Headless Chromium представляется как HeadlessChrome, и часть сервисов отдаёт ему пустую
 * страницу. Подставляем обычный UA той же мажорной версии.
 */
export function desktopUserAgent(versionLine: string): string | null {
  const m = /(\d+)\.\d+\.\d+\.\d+/.exec(versionLine);
  if (!m) return null;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m[1]}.0.0.0 Safari/537.36`;
}

function userAgentArg(executablePath: string): string[] {
  if (cachedUserAgent === undefined) {
    try {
      cachedUserAgent = desktopUserAgent(execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10_000 }));
    } catch (e) {
      warn("browser", "версия Chromium не прочиталась", { error: String(e) });
      cachedUserAgent = null;
    }
  }
  return cachedUserAgent ? [`--user-agent=${cachedUserAgent}`] : [];
}

/** Ожидание кода из письма: одна сессия — один ожидающий. */
interface CodeWaiter {
  resolve: (value: { kind: "code" | "link"; value: string }) => void;
  timer: NodeJS.Timeout;
}

/** Старые сессии писали `browserbase`, пока браузер арендовался. */
export function isOwnBrowser(provider: string | null | undefined): boolean {
  return provider === "local" || provider === "browserbase";
}

function chromeCandidates(): string[] {
  return [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((p): p is string => Boolean(p));
}

export function chromeAvailable(): boolean {
  return chromeCandidates().some((p) => existsSync(p));
}

export function chromeExecutable(): string {
  const found = chromeCandidates().find((p) => existsSync(p));
  if (!found) throw new Error("Chromium не найден: задайте CHROME_PATH");
  return found;
}

/** Профиль Chromium сервиса: cookies живут между сессиями. */
export function serviceProfileDir(store: Store, slug: string): string {
  const name = slug.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(store.dir("browser-profiles"), name);
}

function profileDir(store: Store, slug: string | null, sessionId: string): string {
  if (slug) return serviceProfileDir(store, slug);
  return path.join(store.dir("browser-profiles"), `_tmp-${sessionId}`.replace(/[^a-zA-Z0-9._-]/g, "-"));
}

/**
 * Свой браузер агента: Chromium на машине, Stagehand решает шаги моделью агента.
 * Профиль на slug сервиса хранит cookies между сессиями. Живого экрана нет.
 */
export class ManagedBrowserSession {
  readonly id: string;
  readonly serviceSlug: string | null;
  readonly meta: BrowserSession;
  private stagehand: Stagehand | null = null;
  private browser: LocalBrowserHandle | null = null;
  private waiter: CodeWaiter | null = null;
  /** Код пришёл письмом раньше, чем сессия его попросила: держим недолго. */
  private pendingCode: { value: { kind: "code" | "link"; value: string }; at: number } | null = null;
  private closed = false;
  private shotN = 0;
  private readonly profile: string;
  private readonly ephemeral: boolean;
  private releaseProfile: (() => void) | null = null;

  constructor(
    private readonly deps: BrowserDeps,
    private readonly task: TaskRef,
    id: string,
    serviceSlug: string | null,
    meta: Omit<BrowserSession, "id" | "hasVideo" | "finishedAt">,
  ) {
    this.id = id;
    this.serviceSlug = serviceSlug;
    this.ephemeral = serviceSlug === null;
    this.profile = profileDir(deps.store, serviceSlug, id);
    this.meta = { ...meta, id: this.id, finishedAt: null, hasVideo: false };
  }

  static async open(
    deps: BrowserDeps,
    task: TaskRef,
    args: { runId: string; purpose: string; serviceSlug: string | null; url?: string },
  ): Promise<ManagedBrowserSession> {
    const id = `brw_${randomBytes(8).toString("hex")}`;
    const s = new ManagedBrowserSession(deps, task, id, args.serviceSlug, {
      runId: args.runId,
      startedAt: new Date().toISOString(),
      provider: "local",
      purpose: args.purpose,
      liveUrl: null,
    });
    await deps.store.saveBrowserSession(s.meta);
    await s.connect();
    if (args.url) await s.goto(args.url);
    return s;
  }

  private async connect(): Promise<void> {
    this.releaseProfile = await acquireProfile(this.profile);
    try {
      await mkdir(this.profile, { recursive: true });
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        await rm(path.join(this.profile, name), { force: true }).catch(() => undefined);
      }
      const executablePath = chromeExecutable();
      this.browser = await localBrowser.launch({
        headless: true,
        executablePath,
        userDataDir: this.profile,
        preserveUserDataDir: true,
        chromiumSandbox: process.getuid?.() !== 0,
        viewport: { width: 1280, height: 800 },
        args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", ...userAgentArg(executablePath)],
      });
      this.stagehand = await Stagehand.create({
        browser: this.browser,
        model: { generate: (params: LLMGenerateParams) => this.generate(params) },
      } as never);
    } catch (e) {
      this.releaseProfile?.();
      this.releaseProfile = null;
      throw e;
    }
    await this.action({ type: "open", purpose: this.meta.purpose });
  }

  /** Cookies из другой сессии (Skyvern) — в живой контекст, без второго запуска на том же профиле. */
  async seedState(state: BrowserStorageState): Promise<void> {
    if (!this.browser || this.closed) throw new Error("Сессия браузера закрыта");
    if (state.cookies.length) await this.browser.context.addCookies(state.cookies as never);
    await this.action({ type: "seed-cookies", cookies: state.cookies.length });
  }

  /**
   * Точный текст страницы и значения полей без модели: extract сокращает длинные токены,
   * а ключ нужен символ в символ.
   */
  async read(): Promise<PageReading> {
    const page = await this.page();
    await this.settled();
    const raw = (await page.evaluate(PAGE_READ_SCRIPT)) as { text: string; fields: Array<{ label: string; value: string }> };
    const reading = pageReading(await page.url(), raw.text, raw.fields);
    await this.action({ type: "read", url: reading.url, textChars: reading.text.length, fields: reading.fields.length, tokens: reading.tokens.length });
    return reading;
  }

  /** Stagehand думает той же моделью агента через OpenRouter; токены пишем в usage. */
  private async generate(params: LLMGenerateParams) {
    const messages: ChatMessageIn[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    for (const m of params.messages) {
      const blocks = Array.isArray(m.content) ? m.content : [m.content];
      messages.push({
        role: m.role,
        content: blocks.map((b) =>
          b.type === "text"
            ? { type: "text" as const, text: b.text }
            : { type: "image_url" as const, image_url: { url: `data:${b.mimeType};base64,${b.data}` } },
        ),
      });
    }
    const json = params.responseFormat?.type === "json_schema" ? params.responseFormat : null;
    const r = await this.deps.openRouter.chat(
      messages,
      {
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(json ? { jsonSchema: { name: json.name, schema: json.schema } } : {}),
      },
      this.deps.model,
    );
    await recordUsage(this.deps.store, this.task, "stagehand.llm", "stagehand", r);
    const text = r.text.trim();
    if (json) {
      return {
        role: "assistant",
        content: { type: "text", text },
        outputFormat: "json_schema",
        structuredContent: JSON.parse(stripFence(text)),
      };
    }
    return { role: "assistant", content: { type: "text", text }, outputFormat: "text" };
  }

  private async action(a: Record<string, unknown>): Promise<void> {
    await this.deps.store.appendBrowserAction(this.id, a);
  }

  private sh(): Stagehand {
    if (!this.stagehand || this.closed) throw new Error("Сессия браузера закрыта");
    return this.stagehand;
  }

  private async page() {
    if (!this.browser || this.closed) throw new Error("Сессия браузера закрыта");
    const pages = await this.browser.context.pages();
    return pages[0] ?? (await this.browser.context.newPage());
  }

  async goto(url: string): Promise<void> {
    const page = await this.page();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settlePage(page, { network: true });
    await this.action({ type: "goto", url });
    await this.shot();
  }

  /** Перед чтением страницы моделью: после клика SPA дорисовывается не сразу. */
  private async settled(): Promise<void> {
    await settlePage(await this.page(), { network: false, budgetMs: SETTLE_MS / 2 }).catch(() => undefined);
  }

  /** `variables` — значения для `%name%` в инструкции: Stagehand вводит их, модели не показывает. */
  async act(instruction: string, variables?: Record<string, string>): Promise<{ success: boolean; message: string }> {
    await this.settled();
    try {
      const pending = variables && Object.keys(variables).length ? this.sh().act(instruction, { variables }) : this.sh().act(instruction);
      const r = (await withTimeout("act", STEP_TIMEOUT_MS, pending)) as { success?: boolean; message?: string };
      const out = { success: r.success ?? true, message: maskVariables(r.message ?? "", variables ?? {}) };
      await this.action({ type: "act", instruction, ...out, ...(variables ? { variables: Object.keys(variables) } : {}) });
      return out;
    } finally {
      await this.settled();
      await this.shot();
    }
  }

  /** Кадр страницы после шага. В чате это единственный экран своего браузера. */
  async shot(): Promise<void> {
    if (this.closed || this.shotN >= 30) return;
    try {
      const page = await this.page();
      const buf = await page.screenshot({ type: "jpeg", quality: 55 });
      const file = shotFile(`${this.shotN + 1}.jpg`);
      if (!file) return;
      this.shotN += 1;
      const dir = path.join(this.deps.store.dir("browser-sessions", this.id, "shots"));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, file), buf);
      await this.action({ type: "screenshot", file, url: page.url() });
    } catch (e) {
      warn("browser", "скриншот не сохранился", { error: String(e) });
    }
  }

  async extract(instruction: string, schema?: unknown): Promise<unknown> {
    const zod = toExtractSchema(schema);
    await this.settled();
    const r = (await withTimeout(
      "extract",
      STEP_TIMEOUT_MS,
      zod ? this.sh().extract(instruction, zod as never) : this.sh().extract(instruction),
    )) as { data?: unknown };
    await this.action({ type: "extract", instruction, result: r.data });
    return r.data;
  }

  async observe(instruction: string): Promise<unknown> {
    await this.settled();
    const r = (await withTimeout("observe", STEP_TIMEOUT_MS, this.sh().observe(instruction))) as { data?: unknown };
    await this.action({ type: "observe", instruction, result: r.data });
    return r.data;
  }

  async currentUrl(): Promise<string> {
    return await (await this.page()).url();
  }

  /**
   * Ждёт код или ссылку из письма. Обещание выполняет inbox, когда письмо
   * с кодом приходит тем же процессом.
   */
  waitForCode(timeoutMs: number): Promise<{ kind: "code" | "link"; value: string } | null> {
    if (this.pendingCode && Date.now() - this.pendingCode.at < PENDING_CODE_TTL_MS) {
      const v = this.pendingCode.value;
      this.pendingCode = null;
      return Promise.resolve(v);
    }
    this.pendingCode = null;
    if (this.waiter) clearTimeout(this.waiter.timer);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          this.waiter = null;
          resolve(v);
        },
        timer,
      };
    });
  }

  get waitingForCode(): boolean {
    return this.waiter !== null;
  }

  /** Вызывает inbox: передать код/ссылку в ждущую сессию. */
  deliverCode(v: { kind: "code" | "link"; value: string }): boolean {
    if (!this.waiter) return false;
    this.action({ type: "code-from-email", kind: v.kind, ...(v.kind === "code" ? { code: v.value } : { link: v.value }) }).catch(
      () => undefined,
    );
    this.waiter.resolve(v);
    return true;
  }

  /** Сессия открыта, но код ещё не просила: следующий `waitForCode` получит его сразу. */
  stashCode(v: { kind: "code" | "link"; value: string }): void {
    if (this.closed) return;
    this.pendingCode = { value: v, at: Date.now() };
    this.action({
      type: "code-from-email",
      kind: v.kind,
      stashed: true,
      ...(v.kind === "code" ? { code: v.value } : { link: v.value }),
    }).catch(() => undefined);
  }

  async close(): Promise<BrowserSession> {
    if (this.closed) return this.meta;
    this.closed = true;
    if (this.waiter) {
      this.waiter.resolve({ kind: "code", value: "" });
    }
    // Зависший шаг не должен держать и закрытие: иначе остановка задачи никогда не завершится.
    try {
      if (this.stagehand) await withTimeout("stagehand.close", CLOSE_TIMEOUT_MS, this.stagehand.close());
    } catch (e) {
      warn("browser", "stagehand.close", { error: String(e) });
    }
    try {
      if (this.browser) await withTimeout("browser.close", CLOSE_TIMEOUT_MS, this.browser.close());
    } catch {
      // процесс Chrome уже мог завершиться
    }
    this.releaseProfile?.();
    this.releaseProfile = null;
    if (this.ephemeral) await rm(this.profile, { recursive: true, force: true }).catch(() => undefined);
    await this.action({ type: "close" });
    this.meta.finishedAt = new Date().toISOString();
    this.meta.hasVideo = false;
    this.meta.liveUrl = null;
    await this.deps.store.saveBrowserSession(this.meta);
    log("browser", "сессия закрыта", { id: this.id });
    return this.meta;
  }
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
