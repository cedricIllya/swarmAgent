import type { OutboundEmail, RuntimeReport, SuspendRequest, UsageTotals } from "@swarm/contracts";
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

  /** Страница разрешения Slack. Пусто — control plane без клиента Slack или недоступен. */
  async slackConsent(): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const data = await this.post<{ url?: string }>("/api/runtime/slack-consent", {});
      const url = data.url?.trim() ?? "";
      return url.startsWith("https://") ? url : null;
    } catch (e) {
      warn("control-plane", "не удалось получить разрешение Slack", { error: String(e) });
      return null;
    }
  }

  async report(report: RuntimeReport): Promise<void> {
    try {
      await this.post("/api/runtime/report", report);
    } catch (e) {
      warn("control-plane", "не удалось записать отчёт", { error: String(e) });
    }
  }

  /**
   * Control plane может спать: будим его этим запросом и просим усыпить нашу машину.
   * Итоги usage уходят вместе с просьбой: во сне `/state` недоступен, а расходы на главной нужны.
   */
  async requestSuspend(usage?: UsageTotals): Promise<void> {
    if (!this.enabled) return;
    try {
      const body: SuspendRequest = usage ? { usage } : {};
      await this.post("/api/runtime/suspend", body, 60_000);
    } catch (e) {
      warn("control-plane", "не удалось уснуть", { error: String(e) });
    }
  }
}
