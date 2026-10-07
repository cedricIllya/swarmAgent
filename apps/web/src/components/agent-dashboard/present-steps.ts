import type { RunStep } from "@swarm/contracts";
import { t, type MessageKey } from "../../i18n";

const PAGE_STATE: Record<string, MessageKey> = {
  accept_button: "steps.page.accept_button",
  email_form: "steps.page.email_form",
  signup_form: "steps.page.signup_form",
  password_form: "steps.page.password_form",
  auth_choice: "steps.page.auth_choice",
  code_prompt: "steps.page.code_prompt",
  magic_link_sent: "steps.page.magic_link_sent",
  logged_in: "steps.page.logged_in",
  captcha: "steps.page.captcha",
  expired: "steps.page.expired",
  pending_approval: "steps.page.pending_approval",
  account_exists: "steps.page.account_exists",
  password_rejected: "steps.page.password_rejected",
  other: "steps.page.other",
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
  if (status === "deleting" || /удал/i.test(message)) return t("status.deletingAgent");
  if (status === "failed") return t("status.startFailed");
  return t("status.startingLong");
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

/** Заметки расхода: одинаковые фразы после переписывания показываем один раз. */
export function presentDetails(details: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of details) {
    const line = presentDetail(raw);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function rewrite(text: string): string | null {
  let m: RegExpMatchArray | null;

  m = text.match(/^подключён сервис (.+?) \((?:MCP|API|браузер)\)$/i);
  if (m?.[1]) return t("steps.connected", { name: m[1] });

  m = text.match(/^найден способ входа в (.+?) \((?:MCP|API|браузер)\)$/i);
  if (m?.[1]) return t("steps.foundLogin", { name: m[1] });

  m = text.match(/^сохранённый токен MCP (.+?) сервер не принимает/i);
  if (m?.[1]) return t("steps.keyRejected", { name: m[1] });

  m = text.match(/^ищу способ входа в ([^(]+?)(?:\s*\([^)]*\))?$/i);
  if (m?.[1]) return t("steps.lookingUp", { name: m[1].trim() });

  if (/^поиск в интернете:/i.test(text)) return t("steps.searchingWeb");
  if (/^прочитана документация:/i.test(text)) return t("steps.readingDocs");
  if (/способ входа не найден/i.test(text)) return t("steps.loginFromInvite");

  m = text.match(/^открыт браузер:\s*(.+)$/i);
  if (m?.[1]) return t("steps.openedBrowser", { purpose: purpose(m[1]) });
  if (/^браузер закрыт$/i.test(text)) return t("steps.closedBrowser");

  m = text.match(/^skyvern\s+(\S+):\s*(https?:\/\/\S+)$/i);
  if (m?.[1]) return t("steps.openingBrowser", { purpose: purpose(m[1]) });
  m = text.match(/^skyvern\s+(\S+):\s*(\S+)$/i);
  if (m) return skyvernStatus(m[2] ?? "", m[1] ?? "");

  m = text.match(/^Skyvern:\s*(.+)$/);
  if (m?.[1]) return skyvernStatus(m[1], m[1]);

  if (/^Повторяю вход своим браузером\.?$/i.test(text)) return t("steps.retryingLogin");

  m = text.match(/^шаг \d+:\s*страницу не удалось разобрать/i);
  if (m) return t("steps.pageUnreadable");

  m = text.match(/^шаг \d+:\s*([a-z_]+)(?:\s+[—–-]\s*(.+))?$/i);
  const page = m?.[1] ? PAGE_STATE[m[1]] : undefined;
  if (page) return t(page);

  if (/^открыл приглашение в /i.test(text)) return sentence(text);
  if (/^перешёл по ссылке из письма/i.test(text)) return t("steps.followedEmailLink");
  if (/^ввёл код из письма/i.test(text)) return t("steps.enteredEmailCode");

  m = text.match(/^новая задача в ветке от\s+(.+)$/i);
  if (m?.[1]) return t("steps.newEmailFrom", { from: m[1] });
  m = text.match(/^письмо отправлено\s+(.+)$/i);
  if (m?.[1]) return t("steps.sentEmail", { to: m[1] });
  m = text.match(/^ответ отправлен\s+(.+)$/i);
  if (m?.[1]) return t("steps.replied", { to: m[1] });
  if (/^письмо с вопросом владельцу$/i.test(text)) return t("steps.askedByEmail");

  m = text.match(/^(invite|credential|task|verification):\s*(.+)$/i);
  if (m?.[1] && m[2]) {
    const rest = m[2].replace(/\s*\(код\s+[^)]+\)\s*$/i, "").trim();
    if (/^invite$/i.test(m[1])) return sentence(t("steps.invite", { rest }));
    if (/^credential$/i.test(m[1])) return sentence(t("steps.credential", { rest }));
    if (/^verification$/i.test(m[1])) return sentence(t("steps.verification", { rest }));
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
  if (/капч/i.test(status)) return t("steps.captchaBlocked");
  const phrase = purpose(purposeText).replace(/^принять(?=\s)/i, "принимаю");
  return sentence(phrase);
}

function purpose(value: string): string {
  if (value === "signup") return t("steps.purposeSignup");
  if (value === "login") return t("steps.purposeLogin");
  return value;
}

function humanError(text: string): string | null {
  if (/hermes недоступен/i.test(text)) return t("steps.error.taskFailed");
  if (/нет следов работы/i.test(text)) return t("steps.error.serviceFailed");
  if (/модель не разобрала/i.test(text)) return t("steps.error.emailUnparsed");
  if (/контекст входа потерян/i.test(text)) return t("steps.error.loginLost");
  if (/поиск ключа не удался/i.test(text)) return t("steps.error.keyNotFound");
  if (/\/opt\/|node:|^\s*at\s+\S+\s+\(/i.test(text)) return t("steps.error.generic");
  const clean = tidy(text.replace(VENDOR_WORD, ""));
  if (!clean || HIDE.test(clean)) return t("steps.error.generic");
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
