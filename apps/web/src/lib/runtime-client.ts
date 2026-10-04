import type {
  ChatRequest,
  DeliverEmailRequest,
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
 * HTTP к runtime на машине агента. Адрес приватный (`.flycast` или старый
 * `.internal`), поэтому из локальной разработки он недоступен — для неё есть DEV_RUNTIME_URL.
 */
export class RuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static for(agent: AgentRow): RuntimeClient | null {
    const url = env.devRuntimeUrl ?? agent.runtimeUrl;
    if (!url || !agent.runtimeTokenEnc) return null;
    return new RuntimeClient(url, runtimeTokenOf(agent));
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
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
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(slice) });
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
    return this.call("GET", "/state", undefined, 20_000);
  }

  deliverEmail(body: DeliverEmailRequest): Promise<{ accepted: boolean }> {
    return this.call("POST", "/email", body);
  }

  chat(body: ChatRequest): Promise<{ runId: string }> {
    return this.call("POST", "/chat", body);
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

  resolveApproval(id: string, approved: boolean): Promise<{ runId: string }> {
    return this.call("POST", `/approvals/${id}`, { approved });
  }

  run(id: string): Promise<{ run: unknown; steps: unknown[] }> {
    return this.call("GET", `/runs/${id}`);
  }

  browserActions(sessionId: string): Promise<unknown[]> {
    return this.call("GET", `/browser-sessions/${sessionId}/actions`);
  }

  tick(): Promise<{ deferred: number; checkedServices: boolean }> {
    return this.call("POST", "/tick", {}, 180_000);
  }

  async video(sessionId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/browser-sessions/${sessionId}/video`, {
      headers: { Authorization: `Bearer ${this.token}` },
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
