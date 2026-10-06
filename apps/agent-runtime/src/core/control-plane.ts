import type { OutboundEmail, RuntimeReport } from "@swarm/contracts";
import { warn } from "./log";

/**
 * Обратный канал к control plane. Ключ Mailgun и база лежат там,
 * runtime только просит отправить письмо или записать находку.
 */
export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly agentId: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.baseUrl.length > 0;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.enabled) throw new Error("CONTROL_PLANE_URL не задан");
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-Agent-Id": this.agentId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`control plane ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async sendEmail(mail: OutboundEmail): Promise<{ messageId: string }> {
    return this.post("/api/runtime/send-email", mail);
  }

  async report(report: RuntimeReport): Promise<void> {
    try {
      await this.post("/api/runtime/report", report);
    } catch (e) {
      warn("control-plane", "не удалось записать отчёт", { error: String(e) });
    }
  }

  /** Control plane может спать: будим его этим запросом и просим усыпить нашу машину. */
  async requestSuspend(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.post("/api/runtime/suspend", {}, 60_000);
    } catch (e) {
      warn("control-plane", "не удалось уснуть", { error: String(e) });
    }
  }
}
