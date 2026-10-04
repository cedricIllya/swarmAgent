import type {
  ChatRequest,
  DeliverEmailRequest,
  GoogleTokenRequest,
  RuntimeState,
  SyncServicesRequest,
  UpdateSettingsRequest,
} from "@swarm/contracts";
import { runtimeTokenOf, type AgentRow } from "@swarm/agents";
import { env } from "@/env";

/**
 * HTTP к runtime на машине агента. Адрес приватный (`.internal`), поэтому
 * из локальной разработки он недоступен — для неё есть DEV_RUNTIME_URL.
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
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`runtime ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  state(): Promise<RuntimeState> {
    return this.call("GET", "/state");
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

  async video(sessionId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/browser-sessions/${sessionId}/video`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
  }
}
