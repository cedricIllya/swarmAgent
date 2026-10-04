const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "yi", є: "ye", ґ: "g",
};

export const LOCAL_PART_RE = /^[A-Za-z0-9._-]+$/;

function transliterate(input: string): string {
  let out = "";
  for (const ch of input) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC[lower];
    if (mapped !== undefined) {
      out += mapped;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * `Владимир Ленин` → `vladimir.lenin`. Пустое имя → `agent`.
 * Слова через точку, внутри слова всё не буква-цифра → дефис.
 */
export function localPartFromName(name: string): string {
  const ascii = transliterate(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const parts = ascii
    .split(/\s+/)
    .map((word) =>
      word
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter((w) => w.length > 0);

  const joined = parts.join(".");
  return joined.length > 0 ? joined : "agent";
}

/** `vladimir.lenin` + 2 → `vladimir.lenin2`. Суффикс без лишней точки. */
export function withSuffix(localPart: string, n: number): string {
  return n <= 1 ? localPart : `${localPart}${n}`;
}

/**
 * Подбирает свободную локальную часть. `isTaken` смотрит в реестр.
 */
export async function allocateLocalPart(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  maxTries = 1000,
): Promise<string> {
  for (let n = 1; n <= maxTries; n++) {
    const candidate = withSuffix(base, n);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`Не удалось подобрать адрес для ${base}`);
}

export function validateLocalPart(localPart: string): string | null {
  if (localPart.length === 0) return "Локальная часть пустая";
  if (localPart.length > 64) return "Локальная часть длиннее 64 символов";
  if (!LOCAL_PART_RE.test(localPart)) {
    return "Только буквы, цифры, точки, дефисы, подчёркивания";
  }
  return null;
}

export interface ParsedAddress {
  /** Голая локальная часть без плюс-тега, нижний регистр. */
  localPart: string;
  /** Плюс-тег, если был: для `name+g@domain` это `g`. */
  tag: string | null;
  domain: string;
}

/**
 * `"Agent" <Name+G@Domain.com>` → `{ localPart: "name", tag: "g", domain: "domain.com" }`.
 * Плюс-адрес принадлежит голому адресу.
 */
export function parseAddress(raw: string): ParsedAddress | null {
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? raw).trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const local = addr.slice(0, at).trim();
  const domain = addr.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (!local || !domain) return null;
  const plus = local.indexOf("+");
  const bare = (plus >= 0 ? local.slice(0, plus) : local).toLowerCase();
  const tag = plus >= 0 ? local.slice(plus + 1) : null;
  return { localPart: bare, tag, domain };
}

/** Все адреса из поля To/Cc, уже разобранные. */
export function parseAddressList(raw: string): ParsedAddress[] {
  return raw
    .split(",")
    .map((s) => parseAddress(s))
    .filter((a): a is ParsedAddress => a !== null);
}
