/**
 * Fly Machines API. Агенты — машины одного приложения: у каждой свой volume
 * и свой внешний порт. Два контейнера на машине (Hermes и agent-runtime).
 * https://fly.io/docs/machines/api/
 */

import type { MachineConfig } from "./machine";

export interface FlyConfig {
  apiToken: string;
  org: string;
  region: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  private_ip?: string;
  config?: unknown;
}

export interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
}

export class FlyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

export class FlyClient {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: FlyConfig) {
    this.base = cfg.baseUrl ?? "https://api.machines.dev";
    this.f = cfg.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiToken}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.f(`${this.base}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      const detail = text.replace(/\s+/g, " ").slice(0, 500);
      throw new FlyError(`Fly ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`, res.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getApp(appName: string): Promise<{ name: string; status: string } | null> {
    try {
      return await this.request("GET", `/v1/apps/${appName}`);
    } catch (e) {
      if (e instanceof FlyError && e.status === 404) return null;
      throw e;
    }
  }

  /** Идемпотентно: если приложение уже есть, ничего не делает. */
  async ensureApp(appName: string): Promise<void> {
    if (await this.getApp(appName)) return;
    await this.request("POST", "/v1/apps", {
      app_name: appName,
      org_slug: this.cfg.org,
      enable_subdomains: false,
    });
  }

  private async ipAssignments(appName: string): Promise<Array<{ type?: string }>> {
    const listed = await this.request<Array<{ type?: string }> | { addresses?: Array<{ type?: string }> }>(
      "GET",
      `/v1/apps/${appName}/ip_assignments`,
    );
    return Array.isArray(listed) ? listed : (listed.addresses ?? []);
  }

  /**
   * Приватный адрес `<app>.flycast`. Запрос на него идёт через прокси Fly
   * и сам снимает suspend. Публичный IP не выделяем: сервис машины тогда
   * открылся бы в интернет.
   * Сеть не задаём: адрес попадает в сеть организации, где живёт control plane.
   */
  async ensureFlycast(appName: string): Promise<void> {
    const ips = await this.ipAssignments(appName);
    if (ips.some((ip) => ip.type === "private_v6")) return;
    try {
      await this.request("POST", `/v1/apps/${appName}/ip_assignments`, { type: "private_v6" });
    } catch (e) {
      if (e instanceof FlyError && e.status === 409) return;
      throw e;
    }
  }

  /** Публичный адрес на приложении агентов выставил бы их порты наружу. */
  async assertNoPublicIp(appName: string): Promise<void> {
    const publicTypes = new Set(["v4", "v6", "shared_v4"]);
    const pub = (await this.ipAssignments(appName)).filter((ip) => ip.type && publicTypes.has(ip.type));
    if (pub.length) {
      throw new Error(`У ${appName} есть публичный адрес (${pub.map((ip) => ip.type).join(", ")}): порты агентов вышли бы в интернет`);
    }
  }

  async destroyApp(appName: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/apps/${appName}?force=true`);
    } catch (e) {
      if (e instanceof FlyError && e.status === 404) return;
      throw e;
    }
  }

  async listVolumes(appName: string): Promise<FlyVolume[]> {
    return this.request("GET", `/v1/apps/${appName}/volumes`);
  }

  /**
   * Диск с этим именем. Имя у каждого агента своё: первое совпадение в общем
   * приложении — его диск, не соседний. Повтор после обрыва берёт тот же.
   */
  async ensureVolume(appName: string, name: string, sizeGb: number): Promise<FlyVolume> {
    const existing = (await this.listVolumes(appName)).find((v) => v.name === name);
    if (existing) return existing;
    return this.request("POST", `/v1/apps/${appName}/volumes`, {
      name,
      region: this.cfg.region,
      size_gb: sizeGb,
      encrypted: true,
      snapshot_retention: 5,
    });
  }

  async destroyMachine(appName: string, machineId: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/apps/${appName}/machines/${machineId}?force=true`);
    } catch (e) {
      if (e instanceof FlyError && e.status === 404) return;
      throw e;
    }
  }

  async destroyVolume(appName: string, volumeId: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/apps/${appName}/volumes/${volumeId}`);
    } catch (e) {
      if (e instanceof FlyError && e.status === 404) return;
      throw e;
    }
  }

  async listMachines(appName: string): Promise<FlyMachine[]> {
    return this.request("GET", `/v1/apps/${appName}/machines`);
  }

  async getMachine(appName: string, machineId: string): Promise<FlyMachine | null> {
    try {
      return await this.request("GET", `/v1/apps/${appName}/machines/${machineId}`);
    } catch (e) {
      if (e instanceof FlyError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * `start` поднимает stopped и снимает suspend. Уже запущенная машина
   * отвечает 409/412 — это не ошибка.
   */
  async startMachine(appName: string, machineId: string): Promise<void> {
    try {
      await this.request("POST", `/v1/apps/${appName}/machines/${machineId}/start`);
    } catch (e) {
      if (e instanceof FlyError && (e.status === 409 || e.status === 412)) return;
      throw e;
    }
  }

  /** Память сохраняется, CPU и RAM не тарифицируются. Диск — тарифицируется. */
  async suspendMachine(appName: string, machineId: string): Promise<void> {
    try {
      await this.request("POST", `/v1/apps/${appName}/machines/${machineId}/suspend`);
    } catch (e) {
      if (e instanceof FlyError && (e.status === 409 || e.status === 412)) return;
      throw e;
    }
  }

  async createMachine(appName: string, body: { name: string; config: MachineConfig }): Promise<FlyMachine> {
    return this.request("POST", `/v1/apps/${appName}/machines`, {
      name: body.name,
      region: this.cfg.region,
      config: body.config,
    });
  }

  /** Обновление конфига перезапускает машину с новым образом/окружением. */
  async updateMachine(appName: string, machineId: string, config: MachineConfig): Promise<FlyMachine> {
    return this.request("POST", `/v1/apps/${appName}/machines/${machineId}`, { config });
  }

  async restartMachine(appName: string, machineId: string): Promise<void> {
    await this.request("POST", `/v1/apps/${appName}/machines/${machineId}/restart`);
  }

  /**
   * Ждёт состояние. Один запрос Fly принимает timeout только в диапазоне 1–60 секунд,
   * поэтому длинное ожидание режется на минутные куски. 408 — кусок истёк, машина ещё не там.
   */
  async waitForState(appName: string, machineId: string, state: "started" | "stopped" | "destroyed", timeoutSec = 120): Promise<void> {
    const deadline = Date.now() + Math.max(1, timeoutSec) * 1000;
    while (Date.now() < deadline) {
      const slice = Math.min(60, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)));
      try {
        await this.request("GET", `/v1/apps/${appName}/machines/${machineId}/wait?state=${state}&timeout=${slice}`);
        return;
      } catch (e) {
        if (e instanceof FlyError && e.status === 408 && Date.now() < deadline) continue;
        throw e;
      }
    }
    throw new FlyError(`Fly wait ${state} ${machineId} превысил ${timeoutSec}с`, 408, "");
  }

  async exec(
    appName: string,
    machineId: string,
    command: string[],
    timeoutSec = 60,
    container?: string,
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return this.request("POST", `/v1/apps/${appName}/machines/${machineId}/exec`, {
      command,
      timeout: timeoutSec,
      ...(container ? { container } : {}),
    });
  }
}
