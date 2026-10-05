import { ZodError } from "zod";

/**
 * Hermes собирает тело запроса сам и порой называет поля по-своему: `goal` вместо `purpose`,
 * `action` вместо `instruction`, `message` вместо `text`. Падать на этом нельзя — задача
 * встаёт, а в журнале остаётся только 500. Подставляем первое известное имя.
 */
export type Aliases = Record<string, string[]>;

export const SESSION_ALIASES: Aliases = { sessionId: ["session_id", "session", "id"] };
export const INSTRUCTION_ALIASES: Aliases = {
  ...SESSION_ALIASES,
  instruction: ["action", "prompt", "task", "text", "query", "goal", "description", "command"],
};

export function withAliases(raw: unknown, aliases: Aliases): Record<string, unknown> {
  const body: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  for (const [canonical, names] of Object.entries(aliases)) {
    if (body[canonical] !== undefined && body[canonical] !== null) continue;
    const found = names.find((n) => body[n] !== undefined && body[n] !== null);
    if (found) body[canonical] = body[found];
  }
  return body;
}

/** Skyvern различает регистрацию и вход; Hermes пишет в purpose что угодно — угадываем по смыслу. */
export function skyvernPurpose(raw: unknown, url?: unknown): "signup" | "login" {
  const text = `${typeof raw === "string" ? raw : ""} ${typeof url === "string" ? url : ""}`;
  return /sign[-_ ]?up|регистр|register|создай аккаунт|create account/i.test(text) ? "signup" : "login";
}

/** Понятный ответ 400 вместо стека ZodError: Hermes видит, какого поля не хватило, и чинит запрос сам. */
export function describeZodError(err: ZodError, received: unknown): { error: string; issues: string[]; received: string[] } {
  const issues = err.issues.map((i) => `${i.path.join(".") || "<тело>"}: ${i.message}`);
  const keys = received && typeof received === "object" && !Array.isArray(received) ? Object.keys(received as object) : [];
  return { error: `неверное тело запроса: ${issues.join("; ")}`, issues, received: keys };
}
