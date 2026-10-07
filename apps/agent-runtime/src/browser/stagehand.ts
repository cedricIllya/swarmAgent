import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Stagehand, localBrowser } from "@browserbasehq/stagehand";
import type { BrowserSession } from "@swarm/contracts";
import type { OpenRouterClient, ChatMessageIn } from "../llm/openrouter";
import type { Store } from "../store";
import { recordUsage, type TaskRef } from "../core/usage";
import { log, warn } from "../core/log";
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
/** Медленная страница на одном ядре не укладывается в 15 с Stagehand по умолчанию. */
const NAV_TIMEOUT_MS = 30_000;
/** У `page.goto` к таймауту перехода Stagehand добавляет 10 с на сам RPC. */
const NAV_BACKSTOP_MS = NAV_TIMEOUT_MS + 12_000;
/** `page.evaluate` и `page.screenshot` в Stagehand без своего предела: зависшая страница держит задачу. */
const PAGE_OP_TIMEOUT_MS = 8_000;
const SHOT_TIMEOUT_MS = 8_000;
const LAUNCH_TIMEOUT_MS = 45_000;
/**
 * Мало ядер: site-per-process плодит процессы и страница перестаёт отвечать.
 * Hang monitor показывает диалог «страница зависла» и блокирует переход.
 */
const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-hang-monitor",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--renderer-process-limit=2",
  "--disable-features=Translate,BackForwardCache,IsolateOrigins,site-per-process",
];

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
  const left = () => until - Date.now();
  if (opts.network) {
    const ms = Math.max(1, left());
    await withTimeout("settle.network", ms + 50, page.waitForLoadState("networkidle", ms)).catch(() => undefined);
  }
  for (;;) {
    const slice = Math.max(1, Math.min(2_000, Math.max(left(), 1)));
    let visible: boolean;
    try {
      visible = await withTimeout("settle.text", slice, hasVisibleText(page));
    } catch {
      if (left() <= 0) return;
      continue;
    }
    if (visible || left() <= 0) return;
    const pause = Math.min(TEXT_POLL_MS, left());
    try {
      await withTimeout("settle.sleep", pause + 500, page.waitForTimeout(pause));
    } catch {
      return;
    }
  }
}

/**
 * Что делать после сбоя перехода.
 * `retry-page` — та же сессия, новая вкладка (обрыв сети, редирект).
 * `relaunch` — Chromium уже не отвечает, сессию надо поднять заново.
 */
export function browserFailure(error: unknown): "retry-page" | "relaunch" | "fatal" {
  const text = errorText(error);
  if (/ERR_NAME_NOT_RESOLVED|ERR_CERT_|Сессия браузера закрыта|профиль браузера занят/i.test(text)) return "fatal";
  if (/\b(launch|activePage|pages|newPage|ping):|Chrome exited|debugging port|RPC client is closed|browser has been closed|Session closed|initialization timed out/i.test(text)) {
    return "relaunch";
  }
  if (/ERR_ABORTED|ERR_CONNECTION_|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_FAILED|chrome-error:|страница не открылась|\bgoto:|RPC response timed out: page\.goto|frame detached|Target closed|target closed/i.test(text)) {
    return "retry-page";
  }
  return "fatal";
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(errorText)].join(" ");
  if (error instanceof Error) return `${error.message} ${error.cause ? errorText(error.cause) : ""}`;
  return String(error);
}

/** Закрытие зависло: Chromium с этим профилем ещё жив и держит ядро. Linux — /proc, macOS — ps. */
function killProfileBrowser(profile: string): number {
  const pids = process.platform === "linux" ? linuxChromePids(profile) : darwinChromePids(profile);
  let n = 0;
  for (const pid of pids) {
    if (pid === process.pid || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
      n += 1;
    } catch {
      // уже завершился
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // не лидер группы
    }
  }
  return n;
}

function linuxChromePids(profile: string): number[] {
  let names: string[] = [];
  try {
    names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${name}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdlineUsesProfile(cmd, profile)) continue;
    pids.push(Number(name));
  }
  return pids;
}

function darwinChromePids(profile: string): number[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 3_000 });
  } catch {
    return [];
  }
  return chromePidsFromPs(out, profile);
}

/** Строки `ps -o pid=,command=`: Chromium, у которого в командной строке этот профиль. */
export function chromePidsFromPs(output: string, profile: string): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const pid = m?.[1];
    const cmd = m?.[2];
    if (!pid || !cmd || !cmdlineUsesProfile(cmd, profile)) continue;
    pids.push(Number(pid));
  }
  return pids;
}

function cmdlineUsesProfile(cmd: string, profile: string): boolean {
  return cmd.includes(profile) && /chrom/i.test(cmd);
}

async function withTimeout<T>(what: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  // Поздний отказ исходного обещания после гонки остаётся обработанным.
  p.then(
    () => undefined,
    () => undefined,
  );
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
  /** После срыва перехода следующая команда идёт в новую вкладку, а не в зависшую. */
  private useNewest = false;

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
    try {
      await s.connect();
      if (args.url) await s.goto(args.url);
    } catch (e) {
      // Сессия ещё не в реестре runtime: без закрытия здесь Chromium и замок профиля живут до рестарта машины.
      await s.close().catch(() => undefined);
      throw e;
    }
    return s;
  }

  private async connect(): Promise<void> {
    this.releaseProfile = await acquireProfile(this.profile);
    try {
      const stale = killProfileBrowser(this.profile);
      if (stale) warn("browser", "снял зависший Chromium перед запуском", { n: stale, profile: this.profile });
      await mkdir(this.profile, { recursive: true });
      for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        await rm(path.join(this.profile, name), { force: true }).catch(() => undefined);
      }
      const executablePath = chromeExecutable();
      try {
        this.browser = await withTimeout(
          "launch",
          LAUNCH_TIMEOUT_MS,
          localBrowser.launch({
            headless: true,
            executablePath,
            userDataDir: this.profile,
            preserveUserDataDir: true,
            chromiumSandbox: process.getuid?.() !== 0,
            viewport: { width: 1280, height: 800 },
            args: [...CHROME_ARGS, ...userAgentArg(executablePath)],
          }),
        );
      } catch (e) {
        killProfileBrowser(this.profile);
        throw e;
      }
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

  /** Браузер ещё принимает команды. Мёртвую сессию вызывающий закрывает и поднимает заново. */
  async ready(): Promise<boolean> {
    if (this.closed || !this.browser) return false;
    try {
      await withTimeout("ping", PAGE_OP_TIMEOUT_MS, this.browser.context.pages());
      return true;
    } catch {
      return false;
    }
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
    const raw = (await withTimeout("read", 10_000, page.evaluate(PAGE_READ_SCRIPT))) as {
      text: string;
      fields: Array<{ label: string; value: string }>;
    };
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
    if (this.useNewest) {
      const pages = await withTimeout("pages", PAGE_OP_TIMEOUT_MS, this.browser.context.pages());
      const newest = pages.at(-1);
      if (newest) return newest;
    }
    const active = await withTimeout("activePage", PAGE_OP_TIMEOUT_MS, this.browser.context.activePage());
    if (active) return active;
    const pages = await withTimeout("pages", PAGE_OP_TIMEOUT_MS, this.browser.context.pages());
    return pages.at(-1) ?? (await withTimeout("newPage", PAGE_OP_TIMEOUT_MS, this.browser.context.newPage()));
  }

  /** Зависшая вкладка остаётся: закрытие такой вкладки само не возвращается. Новая становится активной. */
  private async replacePage(): Promise<void> {
    if (!this.browser || this.closed) return;
    const page = await withTimeout("newPage", PAGE_OP_TIMEOUT_MS, this.browser.context.newPage());
    this.useNewest = true;
    await withTimeout("activePage", PAGE_OP_TIMEOUT_MS, this.browser.context.setActivePage(page)).catch(() => undefined);
  }

  async goto(url: string): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const page = await this.page();
        await withTimeout("goto", NAV_BACKSTOP_MS, page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }));
        const landed = await withTimeout("url", 5_000, page.url()).catch(() => "");
        if (/^chrome-error:/i.test(landed)) throw new Error(`страница не открылась: ${landed}`);
        await settlePage(page, { network: true }).catch(() => undefined);
        await this.action({ type: "goto", url });
        await this.shot();
        this.useNewest = false;
        return;
      } catch (e) {
        last = e;
        const kind = browserFailure(e);
        warn("browser", "переход не удался", { url, attempt, error: String(e) });
        if (attempt >= 2 || kind !== "retry-page") break;
        await this.replacePage().catch(() => undefined);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
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
      const buf = await withTimeout("screenshot", SHOT_TIMEOUT_MS, page.screenshot({ type: "jpeg", quality: 55, animations: "disabled" }));
      const file = shotFile(`${this.shotN + 1}.jpg`);
      if (!file) return;
      this.shotN += 1;
      const dir = path.join(this.deps.store.dir("browser-sessions", this.id, "shots"));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, file), buf);
      const url = await withTimeout("url", 5_000, page.url()).catch(() => "");
      await this.action({ type: "screenshot", file, url });
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
    return await withTimeout("url", 5_000, (await this.page()).url());
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
    let stuck = false;
    try {
      if (this.stagehand) await withTimeout("stagehand.close", CLOSE_TIMEOUT_MS, this.stagehand.close());
    } catch (e) {
      stuck = true;
      warn("browser", "stagehand.close", { error: String(e) });
    }
    try {
      if (this.browser) await withTimeout("browser.close", CLOSE_TIMEOUT_MS, this.browser.close());
    } catch {
      stuck = true;
    }
    if (stuck) {
      const killed = killProfileBrowser(this.profile);
      if (killed) warn("browser", "убил зависший Chromium", { id: this.id, n: killed });
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
