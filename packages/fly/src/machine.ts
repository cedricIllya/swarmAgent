/**
 * Конфигурация Machine агента: типы Fly и сборка двухконтейнерной машины
 * (Hermes + agent-runtime) поверх одного volume.
 */

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
    exec?: { command: string[] };
    /** Секунды, не наносекунды и не строка "15s". */
    interval?: number;
    timeout?: number;
    grace_period?: number;
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
  /** hourly | daily | weekly | monthly. Будит stopped/suspended машину. */
  schedule?: string;
  metadata?: Record<string, string>;
}

export const DATA_PATH = "/opt/data";
export const VOLUME_NAME = "agent_data";
export const RUNTIME_PORT = 8787;
/**
 * Volume тарифицируется целиком, пока агент спит: $0.15/ГБ в месяц.
 * 3 ГБ хватает на конфиг Hermes, журнал и несколько роликов.
 * 1 ГБ — минимум Fly, его съедает один длинный ролик. 10 ГБ почти всегда пустые.
 */
export const AGENT_VOLUME_GB = 3;

export function appNameFor(agentId: string): string {
  return `swarm-${agentId.replace(/^agt_/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export function runtimeUrlFor(appName: string): string {
  return `http://${appName}.flycast:${RUNTIME_PORT}`;
}

/** `.flycast` будит машину самим HTTP. Старые `.internal` — нет, их будит API `start`. */
export function wakesOnHttp(runtimeUrl: string | null | undefined): boolean {
  return Boolean(runtimeUrl?.includes(".flycast"));
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
 * разложил config.yaml.
 *
 * Сервис прокси нужен, чтобы запрос на `.flycast` сам снимал suspend.
 * Автостоп выключен: runtime просит suspend через 2 минуты, прокси держал бы
 * машину дольше и дольше брал бы деньги за CPU и RAM.
 * `ports` не пустой: пустой список оставлял машину в `started` без контейнеров.
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
    services: [
      {
        protocol: "tcp",
        internal_port: RUNTIME_PORT,
        autostart: true,
        autostop: "off",
        min_machines_running: 0,
        ports: [{ port: RUNTIME_PORT, handlers: ["http"] }],
      },
    ],
    containers: [
      {
        name: "runtime",
        image: input.runtimeImage,
        env: { ...input.env, PORT: String(RUNTIME_PORT), DATA_DIR: DATA_PATH, BOOTSTRAP_DIR: BOOTSTRAP_PATH },
        files,
        restart: { policy: "always" },
        healthchecks: [
          {
            name: "ready",
            kind: "readiness",
            // Только exec: с http-проверкой pilot не запускает ни один контейнер машины.
            exec: { command: ["wget", "-q", "-O", "/dev/null", `http://127.0.0.1:${RUNTIME_PORT}/health`] },
            interval: 15,
            timeout: 5,
            grace_period: 20,
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
  };
}
