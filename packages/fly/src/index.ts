/**
 * Fly Machines API. Одно приложение на агента: `swarm-<id>`, один volume,
 * одна Machine с двумя контейнерами (Hermes и agent-runtime).
 * https://fly.io/docs/machines/api/
 */

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
    if (!res.ok) throw new FlyError(`Fly ${method} ${path} → ${res.status}`, res.status, text);
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

  async ensureVolume(appName: string, name: string, sizeGb: number): Promise<FlyVolume> {
    const existing = (await this.listVolumes(appName)).find((v) => v.name === name);
    if (existing) return existing;
    return this.request("POST", `/v1/apps/${appName}/volumes`, {
      name,
      region: this.cfg.region,
      size_gb: sizeGb,
      encrypted: true,
      // Одна машина на агента: реплика не нужна.
      snapshot_retention: 5,
    });
  }

  async listMachines(appName: string): Promise<FlyMachine[]> {
    return this.request("GET", `/v1/apps/${appName}/machines`);
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

  async waitForState(appName: string, machineId: string, state: "started" | "stopped" | "destroyed", timeoutSec = 120): Promise<void> {
    await this.request(
      "GET",
      `/v1/apps/${appName}/machines/${machineId}/wait?state=${state}&timeout=${timeoutSec}`,
    );
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

export interface MachineFile {
  guest_path: string;
  raw_value: string;
  /** Права файла в восьмеричной записи, например 0600. */
  mode?: number;
}

export interface MachineContainer {
  name: string;
  image: string;
  env?: Record<string, string>;
  cmd?: string[];
  entrypoint?: string[];
  files?: MachineFile[];
  depends_on?: Array<{ name: string; condition: "started" | "healthy" | "exited_successfully" }>;
  restart?: { policy: "always" | "on-failure" | "no" };
  healthchecks?: Array<{
    name: string;
    http?: { port: number; path: string; method?: string };
    interval?: string;
    timeout?: string;
    grace_period?: string;
    kind?: "readiness" | "liveness";
  }>;
}

export interface MachineConfig {
  image?: string;
  env?: Record<string, string>;
  guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
  mounts?: Array<{ volume: string; path: string; name?: string }>;
  containers?: MachineContainer[];
  files?: MachineFile[];
  services?: Array<{
    protocol: "tcp";
    internal_port: number;
    ports: Array<{ port: number; handlers: string[] }>;
    autostop?: "off" | "stop" | "suspend";
    autostart?: boolean;
    min_machines_running?: number;
  }>;
  auto_destroy?: boolean;
  restart?: { policy: "always" | "on-failure" | "no" };
  metadata?: Record<string, string>;
}

export const DATA_PATH = "/opt/data";
export const VOLUME_NAME = "agent_data";
export const RUNTIME_PORT = 8787;

export function appNameFor(agentId: string): string {
  return `swarm-${agentId.replace(/^agt_/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export function runtimeUrlFor(appName: string): string {
  return `http://${appName}.internal:${RUNTIME_PORT}`;
}

export interface AgentMachineInput {
  volumeId: string;
  hermesImage: string;
  runtimeImage: string;
  /** Переменные для обоих контейнеров. Секреты сюда — машина приватная, порт наружу не публикуем. */
  env: Record<string, string>;
  /**
   * Файлы конфигурации Hermes. Путь — относительно /opt/data. Кладутся в контейнер
   * runtime под /bootstrap, а runtime при старте копирует их на volume: писать
   * напрямую в точку монтирования через `files` нельзя.
   */
  files: Array<{ path: string; content: string; mode?: string }>;
}

export const BOOTSTRAP_PATH = "/bootstrap";

/**
 * Два контейнера на одной Machine. Hermes с s6-overlay хочет быть PID 1 —
 * поэтому не один образ с двумя процессами. Volume примонтирован обоим.
 * Hermes стартует после того, как runtime стал healthy — то есть уже
 * разложил config.yaml. Машина не засыпает: autostop off, restart always.
 */
export function buildAgentMachineConfig(input: AgentMachineInput): MachineConfig {
  const files: MachineFile[] = input.files.map((f) => ({
    guest_path: `${BOOTSTRAP_PATH}/${f.path.replace(/^\/+/, "")}`,
    raw_value: Buffer.from(f.content, "utf8").toString("base64"),
    ...(f.mode ? { mode: parseInt(f.mode, 8) } : {}),
  }));

  return {
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
    mounts: [{ volume: input.volumeId, path: DATA_PATH, name: VOLUME_NAME }],
    restart: { policy: "always" },
    auto_destroy: false,
    metadata: { role: "swarm-agent" },
    containers: [
      {
        name: "runtime",
        image: input.runtimeImage,
        env: { ...input.env, PORT: String(RUNTIME_PORT), DATA_DIR: DATA_PATH, BOOTSTRAP_DIR: BOOTSTRAP_PATH },
        files,
        restart: { policy: "always" },
        healthchecks: [
          {
            name: "http",
            kind: "readiness",
            http: { port: RUNTIME_PORT, path: "/health" },
            interval: "15s",
            timeout: "5s",
            grace_period: "20s",
          },
        ],
      },
      {
        name: "hermes",
        image: input.hermesImage,
        cmd: ["gateway", "run"],
        env: { ...input.env, HERMES_HOME: DATA_PATH },
        depends_on: [{ name: "runtime", condition: "healthy" }],
        restart: { policy: "always" },
      },
    ],
    services: [
      {
        protocol: "tcp",
        internal_port: RUNTIME_PORT,
        ports: [],
        autostop: "off",
        autostart: true,
        min_machines_running: 1,
      },
    ],
  };
}
