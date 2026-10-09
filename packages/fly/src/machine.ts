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
/** Имя диска у агентов, которые ещё живут в собственном приложении `swarm-<id>`. */
export const VOLUME_NAME = "agent_data";
export const RUNTIME_PORT = 8787;
/** Все новые агенты — машины этого приложения, не отдельные приложения. */
export const AGENTS_APP_NAME = "swarm-agents";
/**
 * Внешний порт сервиса машины. У каждой свой: прокси Fly шлёт запрос на порт
 * только тем машинам, у которых этот порт объявлен, и будит именно её.
 * 8787 остаётся внутренним портом процесса.
 */
export const AGENT_PORT_MIN = 20_000;
export const AGENT_PORT_SPAN = 41_000;
/**
 * Volume тарифицируется целиком, пока агент спит: $0.15/ГБ в месяц.
 * 3 ГБ хватает на конфиг Hermes, журнал и несколько роликов.
 * 1 ГБ — минимум Fly, его съедает один длинный ролик. 10 ГБ почти всегда пустые.
 */
export const AGENT_VOLUME_GB = 3;

/** Имя машины внутри общего приложения. Уникально, пока уникален id агента. */
export function machineNameFor(agentId: string): string {
  const name = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 63);
  if (!name) throw new Error("пустое имя машины");
  return name;
}

/**
 * Имя диска. Совпадает с id агента (`agt_` + 20 символов — 24 знака, лимит Fly — 30).
 * Поиск диска по этому имени находит только его, повторный provision берёт тот же.
 */
export function volumeNameFor(agentId: string): string {
  const name = agentId.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(name)) throw new Error(`имя диска не годится: ${agentId}`);
  return name;
}

/** Первый свободный порт, начиная с хеша id. Уже занятые порты живущих машин пропускает. */
export function allocateExternalPort(agentId: string, used: Iterable<number>): number {
  const taken = new Set(used);
  const start = fnv1a(agentId) % AGENT_PORT_SPAN;
  for (let i = 0; i < AGENT_PORT_SPAN; i++) {
    const port = AGENT_PORT_MIN + ((start + i) % AGENT_PORT_SPAN);
    if (!taken.has(port)) return port;
  }
  throw new Error("нет свободного порта для машины агента");
}

function fnv1a(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 1_677_761_9);
  }
  return hash >>> 0;
}

/** Порты из конфига машины Fly. Чужой формат — пустой список, не исключение. */
export function externalPortsFromConfig(config: unknown): number[] {
  if (!config || typeof config !== "object") return [];
  const services = (config as { services?: unknown }).services;
  if (!Array.isArray(services)) return [];
  const ports: number[] = [];
  for (const service of services) {
    if (!service || typeof service !== "object") continue;
    const list = (service as { ports?: unknown }).ports;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const port = entry && typeof entry === "object" ? (entry as { port?: unknown }).port : undefined;
      if (typeof port === "number" && Number.isInteger(port)) ports.push(port);
    }
  }
  return ports;
}

export function externalPortFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const raw = new URL(url).port;
    if (!raw) return null;
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

export function runtimeUrlFor(appName: string, port = RUNTIME_PORT): string {
  return `http://${appName}.flycast:${port}`;
}

/** `.flycast` будит машину самим HTTP. Старые `.internal` — нет, их будит API `start`. */
export function wakesOnHttp(runtimeUrl: string | null | undefined): boolean {
  return Boolean(runtimeUrl?.includes(".flycast"));
}

export interface AgentMachineInput {
  volumeId: string;
  /** Имя диска в Fly. Должно совпасть с именем volume, иначе монтирование не примет. */
  volumeName: string;
  /** Порт прокси. Внутри контейнера процесс по-прежнему слушает `RUNTIME_PORT`. */
  externalPort: number;
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
 * Внешний порт у каждой машины свой, внутренний — 8787.
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
    mounts: [{ volume: input.volumeId, path: DATA_PATH, name: input.volumeName }],
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
        ports: [{ port: input.externalPort, handlers: ["http"] }],
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
