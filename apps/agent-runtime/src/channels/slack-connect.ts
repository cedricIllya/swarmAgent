/**
 * После регистрации в Slack агент сам открывает разрешение приложения
 * в уже вошедшем браузере. Токен приходит на callback control plane.
 * Если кнопку «Разрешить» или одобрение администратора он пройти не может,
 * онбординг оставляет задачу владельцу.
 */

export type SlackGrant =
  | { status: "ready" }
  | { status: "unconfigured" }
  | { status: "admin"; notes: string }
  | { status: "stuck"; notes: string };

export const SLACK_ALLOW =
  "Нужно разрешить приложению отвечать в Slack от аккаунта агента. Откройте оставленный браузер и нажмите «Разрешить».";

export const SLACK_ADMIN =
  "Администратор Slack должен одобрить приложение для аккаунта агента. Когда одобрит, нажмите «Одобрил, продолжай».";

export const SLACK_GRANT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["allowed", "admin", "stuck"] },
    notes: { type: "string" },
  },
  required: ["outcome", "notes"],
} as const;

export const SLACK_GRANT_PROMPT = [
  "Это страница разрешения Slack. Пользователь уже вошёл.",
  "Если есть кнопка Allow или «Разрешить» — нажми её один раз и дождись перехода на другой сайт.",
  "Если написано, что приложение должен одобрить администратор рабочего пространства — ничего не нажимай.",
  "Не выходи из аккаунта, не меняй пароль и не открывай другие настройки.",
  "outcome: allowed — кнопка нажата или доступ уже есть; admin — нужно одобрение администратора; stuck — это не страница разрешения или кнопку нажать не вышло.",
].join(" ");

export function isSlackConnect(url: string, slug: string): boolean {
  if (slug === "slack") return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

export function interpretSlackGrant(output: unknown): { outcome: "allowed" | "admin" | "stuck"; notes: string } {
  const row = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  const outcome = row.outcome === "allowed" || row.outcome === "admin" || row.outcome === "stuck" ? row.outcome : "stuck";
  const notes = typeof row.notes === "string" ? row.notes.trim() : "";
  return { outcome, notes };
}

/** Токен уже в доступе — готово. Иначе браузер открывает согласие и нажимает «Разрешить». */
export async function grantSlackAccess(args: {
  consentUrl: string | null;
  hasToken: () => Promise<boolean>;
  approve: (url: string) => Promise<unknown>;
}): Promise<SlackGrant> {
  if (await args.hasToken()) return { status: "ready" };
  if (!args.consentUrl) return { status: "unconfigured" };
  let output: unknown = null;
  try {
    output = await args.approve(args.consentUrl);
  } catch {
    output = null;
  }
  if (await args.hasToken()) return { status: "ready" };
  const grant = interpretSlackGrant(output);
  if (grant.outcome === "admin") return { status: "admin", notes: grant.notes || SLACK_ADMIN };
  return { status: "stuck", notes: grant.notes || SLACK_ALLOW };
}
