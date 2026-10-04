import Browserbase from "@browserbasehq/sdk";
import { Stagehand, browserbase } from "@browserbasehq/stagehand";
import type { BrowserSession } from "@swarm/contracts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { OpenRouterClient, ChatMessageIn } from "../openrouter";
import type { Store } from "../store";
import { recordUsage, type TaskRef } from "../usage";
import { downloadRecording } from "./recordings";
import { log, warn } from "../log";

type LLMContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

type LLMGenerateParams = {
  messages: Array<{ role: "user" | "assistant"; content: LLMContentBlock | LLMContentBlock[] }>;
  systemPrompt?: string;
  temperature?: number;
  responseFormat?: { type: "text" } | { type: "json_schema"; name: string; schema: unknown };
};

export interface BrowserDeps {
  bb: Browserbase;
  projectId: string;
  apiKey: string;
  openRouter: OpenRouterClient;
  model: string;
  store: Store;
}

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

/** Ожидание кода из письма: одна сессия — один ожидающий. */
interface CodeWaiter {
  resolve: (value: { kind: "code" | "link"; value: string }) => void;
  timer: NodeJS.Timeout;
}

/**
 * Одна сессия Browserbase со Stagehand поверх неё. Клиент сессии живёт в этом
 * процессе — поэтому письмо с кодом, принятое тем же процессом, можно ввести
 * прямо сюда. Каждый шаг пишется в `actions.jsonl`, после закрытия качается MP4.
 */
export class ManagedBrowserSession {
  readonly id: string;
  readonly meta: BrowserSession;
  private stagehand: Stagehand | null = null;
  private browser: Awaited<ReturnType<typeof browserbase.connect>> | null = null;
  private waiter: CodeWaiter | null = null;
  /** Код пришёл письмом раньше, чем сессия его попросила: держим недолго. */
  private pendingCode: { value: { kind: "code" | "link"; value: string }; at: number } | null = null;
  private closed = false;

  constructor(
    private readonly deps: BrowserDeps,
    private readonly task: TaskRef,
    readonly browserbaseSessionId: string,
    meta: Omit<BrowserSession, "id" | "hasVideo" | "finishedAt">,
  ) {
    this.id = browserbaseSessionId;
    this.meta = { ...meta, id: this.id, finishedAt: null, hasVideo: false };
  }

  static async open(
    deps: BrowserDeps,
    task: TaskRef,
    args: { runId: string; purpose: string; serviceSlug: string | null; url?: string },
  ): Promise<ManagedBrowserSession> {
    const contextId = args.serviceSlug ? await ensureContext(deps, args.serviceSlug) : null;
    const session = await deps.bb.sessions.create({
      projectId: deps.projectId,
      keepAlive: true,
      browserSettings: {
        recordSession: true,
        ...(contextId ? { context: { id: contextId, persist: true } } : {}),
      },
    });
    let liveUrl: string | null = null;
    try {
      const links = await deps.bb.sessions.debug(session.id);
      const url = links.debuggerFullscreenUrl;
      liveUrl = url ? `${url}${url.includes("?") ? "&" : "?"}navbar=false` : null;
    } catch (e) {
      warn("browser", "live view недоступен", { error: String(e) });
    }
    const s = new ManagedBrowserSession(deps, task, session.id, {
      runId: args.runId,
      startedAt: new Date().toISOString(),
      provider: "browserbase",
      purpose: args.purpose,
      liveUrl,
    });
    await deps.store.saveBrowserSession(s.meta);
    await s.connect();
    if (args.url) await s.goto(args.url);
    return s;
  }

  private async connect(): Promise<void> {
    this.browser = await browserbase.connect({ apiKey: this.deps.apiKey, sessionId: this.browserbaseSessionId });
    this.stagehand = await Stagehand.create({
      browser: this.browser,
      model: { generate: (params: LLMGenerateParams) => this.generate(params) },
    } as never);
    await this.action({ type: "open", purpose: this.meta.purpose });
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

  async goto(url: string): Promise<void> {
    const pages = await this.browser!.context.pages();
    const page = pages[0] ?? (await this.browser!.context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await this.action({ type: "goto", url });
  }

  async act(instruction: string): Promise<{ success: boolean; message: string }> {
    const r = (await this.sh().act(instruction)) as { success?: boolean; message?: string };
    const out = { success: r.success ?? true, message: r.message ?? "" };
    await this.action({ type: "act", instruction, ...out });
    return out;
  }

  async extract(instruction: string, schema?: unknown): Promise<unknown> {
    const r = (await (schema
      ? this.sh().extract(instruction, schema as never)
      : this.sh().extract(instruction))) as { data?: unknown };
    await this.action({ type: "extract", instruction, result: r.data });
    return r.data;
  }

  async observe(instruction: string): Promise<unknown> {
    const r = (await this.sh().observe(instruction)) as { data?: unknown };
    await this.action({ type: "observe", instruction, result: r.data });
    return r.data;
  }

  async currentUrl(): Promise<string> {
    const pages = await this.browser!.context.pages();
    return pages[0]?.url() ?? "";
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
    this.action({ type: "code-from-email", kind: v.kind }).catch(() => undefined);
    this.waiter.resolve(v);
    return true;
  }

  /** Сессия открыта, но код ещё не просила: следующий `waitForCode` получит его сразу. */
  stashCode(v: { kind: "code" | "link"; value: string }): void {
    if (this.closed) return;
    this.pendingCode = { value: v, at: Date.now() };
    this.action({ type: "code-from-email", kind: v.kind, stashed: true }).catch(() => undefined);
  }

  async close(): Promise<BrowserSession> {
    if (this.closed) return this.meta;
    this.closed = true;
    if (this.waiter) {
      this.waiter.resolve({ kind: "code", value: "" });
    }
    try {
      await this.stagehand?.close();
    } catch (e) {
      warn("browser", "stagehand.close", { error: String(e) });
    }
    try {
      await this.browser?.close();
    } catch {
      // сессия может быть уже закрыта
    }
    try {
      await this.deps.bb.sessions.update(this.browserbaseSessionId, {
        projectId: this.deps.projectId,
        status: "REQUEST_RELEASE",
      });
    } catch (e) {
      warn("browser", "release", { error: String(e) });
    }
    await this.action({ type: "close" });
    const hasVideo = await downloadRecording(
      this.deps.bb,
      this.browserbaseSessionId,
      this.deps.store.videoPath(this.id),
    );
    this.meta.finishedAt = new Date().toISOString();
    this.meta.hasVideo = hasVideo;
    this.meta.liveUrl = null;
    await this.deps.store.saveBrowserSession(this.meta);
    log("browser", "сессия закрыта", { id: this.id, hasVideo });
    return this.meta;
  }
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

/**
 * Browserbase Context хранит cookies между сессиями. Один контекст на сервис,
 * id лежит в `browser-profiles/<slug>.json` на volume этого агента.
 */
export async function ensureContext(deps: BrowserDeps, slug: string): Promise<string> {
  const file = path.join(deps.store.dir("browser-profiles"), `${slug}.json`);
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { contextId: string };
    if (saved.contextId) return saved.contextId;
  } catch {
    // нет профиля — создадим
  }
  const ctx = await deps.bb.contexts.create({ projectId: deps.projectId });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ contextId: ctx.id, createdAt: new Date().toISOString() }));
  return ctx.id;
}
