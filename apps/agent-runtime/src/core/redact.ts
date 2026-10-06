/**
 * Текст, который увидит человек: чат, письмо, одобрение, итог задачи.
 * Модель знает локальные адреса и имена ключей, чтобы работать, но в ответ они не попадают.
 */
const LOCAL_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s)'"]*)?/gi;
const INTERNAL_HOST = /https?:\/\/[a-z0-9.-]+\.(?:internal|flycast)(?::\d+)?(?:\/[^\s)'"]*)?/gi;
const DATA_PATH = /\/opt\/data(?:\/[^\s)'"]*)?/g;
const BEARER = /Bearer\s+\S+/g;
const SECRET_NAME =
  /\$?(?:SWARM_RUNTIME_TOKEN|API_SERVER_KEY|API_SERVER_ENABLED|API_SERVER_HOST|API_SERVER_PORT|OPENROUTER_API_KEY|SKYVERN_API_KEY|HERMES_API_KEY|HERMES_API_URL|HERMES_HOME)\b(?:\s*[=:]\s*\S+)?/g;
const AUTH_HEADER = /Authorization:\s*/gi;
/** Пароль из credentials, если модель процитировала JSON доступа. */
const PASSWORD_FIELD = /"password"\s*:\s*"[^"]*"/gi;

const EMPTY_FALLBACK = "Готово. Внутренние подробности работы не показываю.";

export function redactInternal(text: string): string {
  const out = text
    .replace(LOCAL_URL, "")
    .replace(INTERNAL_HOST, "")
    .replace(DATA_PATH, "")
    .replace(BEARER, "")
    .replace(SECRET_NAME, "")
    .replace(AUTH_HEADER, "")
    .replace(PASSWORD_FIELD, '"password":"***"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.trim() && !out ? EMPTY_FALLBACK : out;
}
