import { en } from "./en";
import { ru } from "./ru";

export type Locale = "en" | "ru";

/** Active language. A picker is not wired yet, so the product stays in English. */
export const locale: Locale = "en";

export const intlLocale = "en";

const catalogs = { en, ru } as const;

type Join<Prefix extends string, Key extends string> = Prefix extends "" ? Key : `${Prefix}.${Key}`;

type Leaves<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : { [K in keyof T & string]: Leaves<T[K], Join<Prefix, K>> }[keyof T & string];

export type MessageKey = Leaves<typeof en>;

type Vars = Record<string, string | number>;

function lookup(dict: unknown, path: string): string {
  let cur: unknown = dict;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") throw new Error(`Missing message ${path}`);
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== "string") throw new Error(`Missing message ${path}`);
  return cur;
}

function fill(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (token, key: string) => {
    const value = vars[key];
    return value === undefined ? token : String(value);
  });
}

export function t(key: MessageKey, vars?: Vars): string {
  return fill(lookup(catalogs[locale], key), vars);
}

type PluralKey = "tasks" | "agents";

function pluralForm(n: number): "one" | "few" | "many" {
  if (locale === "en") return n === 1 ? "one" : "many";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "few";
  return "many";
}

/** "{n} task" / "{n} tasks", using the active locale's plural rules. */
export function count(n: number, key: PluralKey): string {
  const word = catalogs[locale].plural[key][pluralForm(n)];
  return `${n.toLocaleString(intlLocale)} ${word}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString(intlLocale);
}
