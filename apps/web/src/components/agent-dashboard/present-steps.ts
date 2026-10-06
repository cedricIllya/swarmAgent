import type { RunStep } from "@swarm/contracts";

const PAGE_STATE: Record<string, string> = {
  accept_button: "Нажимаю «Принять»",
  email_form: "Ввожу почту",
  signup_form: "Заполняю регистрацию",
  password_form: "Ввожу пароль",
  auth_choice: "Выбираю способ входа",
  code_prompt: "Жду код из письма",
  magic_link_sent: "Жду ссылку из письма",
  logged_in: "Вошёл в аккаунт",
  captcha: "На странице проверка",
  expired: "Приглашение истекло",
  pending_approval: "Жду, пока заявку одобрят",
  account_exists: "Аккаунт уже есть, вхожу",
  password_rejected: "Пароль не подошёл",
  other: "Смотрю страницу",
};

const HIDE =
  /^(?:чат:|реестр\b)|cookies|рецепт|слаг|реестр MCP|\bMCP\b|поиск уже дал|страницы не читаю|документацию не ищу|config\.yaml|\.env\b|\brunId\b/i;

const VENDOR_WORD = /\b(?:Hermes|OpenRouter|Skyvern|Fly\.io|flycast|runtime)\b/i;

/** Строка журнала, которую можно показать человеку. `null` — служебная, её не выводим. */
export function presentStep(step: Pick<RunStep, "kind" | "text">): string | null {
  const text = step.text.replace(/\s+/g, " ").trim();
  if (!text || step.kind === "model") return null;
  if (step.kind === "error") return humanError(text);
  const line = rewrite(text);
  if (line === null) return null;
  return line || null;
}

/** Те же правила для коротких строк в расходах: там нет kind, но тексты те же. */
export function presentDetail(text: string): string | null {
  return presentStep({ kind: "note", text });
}

/** Ответ агента и итог задачи: фразы про внутреннюю кухню выкидываем целиком. */
export function forPerson(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((part) => part.trim() && !VENDOR_WORD.test(part));
  return tidy(kept.join(" "));
}

/** Статус на карточке: старые фразы про Fly и Hermes не показываем как есть. */
export function personStatus(message: string, status?: string): string {
  const internal = VENDOR_WORD.test(message) || /\bFly\b/i.test(message) || message === "Удаляем машину";
  if (!internal) return message;
  if (status === "deleting" || /удал/i.test(message)) return "Удаляем агента";
  if (status === "failed") return "Не получилось запустить агента";
  return "Агент запускается — обычно это занимает несколько минут";
}

export function presentSteps(steps: RunStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const line = presentStep(step);
    if (!line || out.at(-1) === line) continue;
    out.push(line);
  }
  return out;
}

function rewrite(text: string): string | null {
  let m: RegExpMatchArray | null;

  m = text.match(/^подключён сервис (.+?) \((?:MCP|API|браузер)\)$/i);
  if (m?.[1]) return `Подключил ${m[1]}`;

  m = text.match(/^найден способ входа в (.+?) \((?:MCP|API|браузер)\)$/i);
  if (m?.[1]) return `Нашёл, как входить в ${m[1]}`;

  m = text.match(/^сохранённый токен MCP (.+?) сервер не принимает/i);
  if (m?.[1]) return `Ключ ${m[1]} не подошёл, убрал его`;

  m = text.match(/^ищу способ входа в ([^(]+?)(?:\s*\([^)]*\))?$/i);
  if (m?.[1]) return `Ищу, как войти в ${m[1].trim()}`;

  if (/^поиск в интернете:/i.test(text)) return "Ищу в интернете";
  if (/^прочитана документация:/i.test(text)) return "Читаю документацию сервиса";
  if (/способ входа не найден/i.test(text)) return "Вхожу по ссылке из приглашения";

  m = text.match(/^открыт браузер:\s*(.+)$/i);
  if (m?.[1]) return `Открыл браузер: ${purpose(m[1])}`;
  if (/^браузер закрыт$/i.test(text)) return "Закрыл браузер";

  m = text.match(/^skyvern\s+(\S+):\s*(https?:\/\/\S+)$/i);
  if (m?.[1]) return `Открываю браузер: ${purpose(m[1])}`;
  m = text.match(/^skyvern\s+(\S+):\s*(\S+)$/i);
  if (m) return skyvernStatus(m[2] ?? "", m[1] ?? "");

  m = text.match(/^Skyvern:\s*(.+)$/);
  if (m?.[1]) return skyvernStatus(m[1], m[1]);

  if (/^Повторяю вход своим браузером\.?$/i.test(text)) return "Повторяю вход";

  m = text.match(/^шаг \d+:\s*страницу не удалось разобрать/i);
  if (m) return "Не удалось разобрать страницу";

  m = text.match(/^шаг \d+:\s*([a-z_]+)(?:\s+[—–-]\s*(.+))?$/i);
  const page = m?.[1] ? PAGE_STATE[m[1]] : undefined;
  if (page) return page;

  if (/^открыл приглашение в /i.test(text)) return sentence(text);
  if (/^перешёл по ссылке из письма/i.test(text)) return "Перешёл по ссылке из письма";
  if (/^ввёл код из письма/i.test(text)) return "Ввёл код из письма";

  m = text.match(/^новая задача в ветке от\s+(.+)$/i);
  if (m?.[1]) return `Новое письмо от ${m[1]}`;
  m = text.match(/^письмо отправлено\s+(.+)$/i);
  if (m?.[1]) return `Отправил письмо ${m[1]}`;
  m = text.match(/^ответ отправлен\s+(.+)$/i);
  if (m?.[1]) return `Ответил ${m[1]}`;
  if (/^письмо с вопросом владельцу$/i.test(text)) return "Спросил вас письмом";

  m = text.match(/^(invite|credential|task|verification):\s*(.+)$/i);
  if (m?.[1] && m[2]) {
    const rest = m[2].replace(/\s*\(код\s+[^)]+\)\s*$/i, "").trim();
    if (/^invite$/i.test(m[1])) return sentence(`Приглашение: ${rest}`);
    if (/^credential$/i.test(m[1])) return sentence(`Ключ: ${rest}`);
    if (/^verification$/i.test(m[1])) return sentence(`Подтверждение: ${rest}`);
    return sentence(rest);
  }

  m = text.match(/^автономно:\s*(.+)$/i);
  if (m?.[1]) return sentence(m[1]);

  if (HIDE.test(text) || VENDOR_WORD.test(text)) return null;
  const clean = tidy(text);
  if (!clean || HIDE.test(clean)) return null;
  return sentence(clean);
}

function skyvernStatus(status: string, purposeText: string): string | null {
  if (/^(created|queued|running|completed|complete|failed|canceled|cancelled|timed_out|timeout)$/i.test(status)) {
    return null;
  }
  if (/капч/i.test(status)) return "Не прошёл проверку на странице, нужен человек";
  const phrase = purpose(purposeText).replace(/^принять(?=\s)/i, "принимаю");
  return sentence(phrase);
}

function purpose(value: string): string {
  if (value === "signup") return "регистрация";
  if (value === "login") return "вход";
  return value;
}

function humanError(text: string): string | null {
  if (/hermes недоступен/i.test(text)) return "Не получилось выполнить задачу";
  if (/нет следов работы/i.test(text)) return "Не удалось сделать это в сервисе";
  if (/модель не разобрала/i.test(text)) return "Не разобрал письмо";
  if (/контекст входа потерян/i.test(text)) return "Не удалось продолжить вход";
  if (/поиск ключа не удался/i.test(text)) return "Не удалось найти ключ";
  if (/\/opt\/|node:|^\s*at\s+\S+\s+\(/i.test(text)) return "Что-то пошло не так";
  const clean = tidy(text.replace(VENDOR_WORD, ""));
  if (!clean || HIDE.test(clean)) return "Что-то пошло не так";
  return sentence(clean);
}

function sentence(text: string): string {
  const t = tidy(text);
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.:;])/g, "$1")
    .replace(/^[,.:;\s]+/, "")
    .trim();
}
