import type {
  ChatMessage,
  ChatRequest,
  ChatThread,
  DeliverEmailRequest,
  DeliverSlackEventRequest,
  GoogleTokenRequest,
  RuntimeState,
  SyncServicesRequest,
  UpdateSettingsRequest,
} from "@swarm/contracts";
import { runtimeTokenOf, type AgentRow } from "@swarm/agents";
import { wakesOnHttp } from "@swarm/fly";
import { env } from "@/env";
import { holdMachine, wakeAgent } from "@/lib/fly-machines";

/** Node отдаёт «fetch failed», а причина (ECONNREFUSED, ENOTFOUND) лежит в `cause`. */
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return `${e.message}: ${code ? `${code} ` : ""}${cause.message}`;
  }
  return e.message;
}

/**
 * HTTP к runtime на машине агента. Адрес приватный (`.flycast` с портом этой
 * машины или старый `.internal`). Заголовок `fly-force-instance-id` не даёт
 * общему приложению отдать запрос соседу. Из локальной разработки адрес
 * недоступен — для неё есть DEV_RUNTIME_URL.
 */
export class RuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    /** Без него общий `.flycast` отдал бы запрос любой машине приложения. */
    private readonly machineId: string | null,
  ) {}

  static for(agent: AgentRow): RuntimeClient | null {
    const url = env.devRuntimeUrl ?? agent.runtimeUrl;
    if (!url || !agent.runtimeTokenEnc) return null;
    return new RuntimeClient(url, runtimeTokenOf(agent), agent.flyMachineId);
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) headers["Content-Type"] = "application/json";
    if (this.machineId) headers["fly-force-instance-id"] = this.machineId;
    return headers;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.headers(true),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      throw new Error(`runtime ${path}: ${describe(e)}`, { cause: e });
    }
    if (!res.ok) throw new Error(`runtime ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * После resume порт появляется не сразу. На `.flycast` один длинный запрос
   * и есть пробуждение: прокси держит соединение, пока машина не встанет.
   * Короткий обрыв этого запроса срывает подъём.
   */
  async waitHealthy(timeoutMs = 60_000, attemptTimeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      const slice = Math.min(attemptTimeoutMs, Math.max(1_000, deadline - Date.now()));
      try {
        const res = await fetch(`${this.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(slice) });
        if (res.ok) return;
        last = new Error(`health → ${res.status}`);
      } catch (e) {
        last = e;
      }
      if (Date.now() + 1_000 >= deadline) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`runtime не поднялся за ${Math.round(timeoutMs / 1000)}с: ${describe(last)}`);
  }

  state(): Promise<RuntimeState> {
    return this.call("GET", "/state", undefined, 40_000);
  }

  deliverEmail(body: DeliverEmailRequest): Promise<{ accepted: boolean }> {
    return this.call("POST", "/email", body);
  }

  deliverSlack(body: DeliverSlackEventRequest): Promise<{ status: "accepted" | "duplicate" | "ignored" | "unavailable" }> {
    return this.call("POST", "/channel/slack", body, 30_000);
  }

  chat(body: ChatRequest): Promise<{ runId: string; chatId: string }> {
    return this.call("POST", "/chat", body, 60_000);
  }

  retryChat(chatId: string, body: { runId: string; author: string }): Promise<{ runId: string; chatId: string }> {
    return this.call("POST", `/chats/${chatId}/retry`, body, 60_000);
  }

  chats(): Promise<ChatThread[]> {
    return this.call("GET", "/chats");
  }

  createChat(title?: string): Promise<ChatThread> {
    return this.call("POST", "/chats", title ? { title } : {});
  }

  chatMessages(id: string): Promise<ChatMessage[]> {
    return this.call("GET", `/chats/${id}/messages`);
  }

  renameChat(id: string, title: string): Promise<ChatThread> {
    return this.call("PATCH", `/chats/${id}`, { title });
  }

  deleteChat(id: string): Promise<{ ok: boolean }> {
    return this.call("DELETE", `/chats/${id}`);
  }

  /** Таймаут только на ответ: сам поток живёт, пока его держит браузер. */
  async events(signal: AbortSignal, headersTimeoutMs = 15_000): Promise<Response> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`нет ответа за ${headersTimeoutMs / 1000}с`)), headersTimeoutMs);
    try {
      return await fetch(`${this.baseUrl}/events`, {
        headers: { ...this.headers(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  updateSettings(body: UpdateSettingsRequest): Promise<{ ok: boolean }> {
    return this.call("POST", "/settings", body);
  }

  syncServices(body: SyncServicesRequest): Promise<{ ok: boolean }> {
    return this.call("POST", "/services", body);
  }

  googleToken(body: GoogleTokenRequest): Promise<{ ok: boolean }> {
    return this.call("POST", "/google-token", body);
  }

  deleteGoogleToken(): Promise<{ ok: boolean }> {
    return this.call("DELETE", "/google-token");
  }

  resolveApproval(
    id: string,
    decision: { approved: boolean } | { answer: string } | { optionIndex: number },
  ): Promise<{ runId: string; answer?: string }> {
    return this.call("POST", `/approvals/${id}`, decision, 30_000);
  }

  run(id: string): Promise<{ run: unknown; steps: unknown[] }> {
    return this.call("GET", `/runs/${id}`);
  }

  cancelRun(id: string): Promise<{ runId: string; status: string }> {
    return this.call("POST", `/runs/${id}/cancel`, {}, 30_000);
  }

  answerRun(id: string, answer: string): Promise<{ runId: string; status: string }> {
    return this.call("POST", `/runs/${id}/answer`, { answer }, 30_000);
  }

  browserActions(sessionId: string): Promise<unknown[]> {
    return this.call("GET", `/browser-sessions/${sessionId}/actions`);
  }

  tick(): Promise<{ deferred: number; checkedServices: boolean; quiet?: "leave" | "clear" | "until"; quietUntil?: string | null }> {
    return this.call("POST", "/tick", {}, 180_000);
  }

  async video(sessionId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/browser-sessions/${sessionId}/video`, {
      headers: this.headers(),
    });
  }

  async shot(sessionId: string, file: string): Promise<Response> {
    return fetch(`${this.baseUrl}/browser-sessions/${sessionId}/shots/${encodeURIComponent(file)}`, {
      headers: this.headers(),
    });
  }
}

/** Разбудить машину и только потом звать runtime. Опрос карточки сюда не ходит. */
export async function awakeRuntime(agent: AgentRow, holdMs = 30_000): Promise<RuntimeClient | null> {
  if (agent.status !== "running") return null;
  const client = RuntimeClient.for(agent);
  if (!client) return null;
  if (!env.devRuntimeUrl && wakesOnHttp(agent.runtimeUrl)) {
    const waitMs = Math.max(holdMs, 45_000);
    holdMachine(agent.id, waitMs);
    await client.waitHealthy(waitMs, waitMs);
    return client;
  }
  if (await wakeAgent(agent, holdMs)) await client.waitHealthy();
  return client;
}
