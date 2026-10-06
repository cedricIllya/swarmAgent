import type { ServiceCredential, ServicesSnapshot } from "@swarm/contracts";

/**
 * Секреты доступа, которые модель называет в шаге браузера по имени: `%email%`, `%password%`.
 * Значение подставляет Stagehand при вводе, в подсказку модели и в журнал оно не попадает.
 */
export const SECRET_VARIABLES = ["email", "password", "name"] as const;
export type SecretVariable = (typeof SECRET_VARIABLES)[number];

export function referencedVariables(instruction: string): SecretVariable[] {
  const found = new Set<SecretVariable>();
  for (const m of instruction.matchAll(/%([a-z_]+)%/gi)) {
    const name = m[1]!.toLowerCase();
    if ((SECRET_VARIABLES as readonly string[]).includes(name)) found.add(name as SecretVariable);
  }
  return [...found];
}

export function credentialVariables(cred: ServiceCredential | undefined): Partial<Record<SecretVariable, string>> {
  const out: Partial<Record<SecretVariable, string>> = {};
  if (cred?.accountEmail) out.email = cred.accountEmail;
  if (cred?.password) out.password = cred.password;
  if (cred?.accountName) out.name = cred.accountName;
  return out;
}

/** Ответ Stagehand иногда повторяет введённое значение: в ответ модели уходит только имя переменной. */
export function maskVariables(text: string, variables: Partial<Record<SecretVariable, string>>): string {
  let out = text;
  for (const [name, value] of Object.entries(variables)) {
    if (value && value.length >= 4) out = out.split(value).join(`%${name}%`);
  }
  return out;
}

/**
 * Вопрос владельцу о входе в сервис, для которого пароль уже лежит в доступе агента.
 * Такой вопрос не нужен: runtime сам вводит пароль через `%password%`.
 */
export function storedLoginAsked(question: string, services: ServicesSnapshot | null): string | null {
  if (!services || !/парол|password|credential|логин|учётн|учетн|войти|вход/i.test(question)) return null;
  const q = question.toLowerCase();
  for (const cred of services.credentials) {
    if (!cred.password) continue;
    const recipe = services.recipes.find((r) => r.slug === cred.slug);
    const marks = [cred.slug, cred.accountEmail, recipe?.name, ...(recipe?.domains ?? [])]
      .filter((m): m is string => Boolean(m && m.length >= 3))
      .map((m) => m.toLowerCase());
    if (marks.some((m) => q.includes(m))) return cred.slug;
  }
  return null;
}
