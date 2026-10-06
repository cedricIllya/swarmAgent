import { hostOf, isNoiseDomain, rootDomain, sameBrand } from "../onboarding/domains";

/**
 * Приглашение, которое видно без модели: ссылка принятия или тема «приглашение».
 * Классификатор на 429 и пустом ответе сюда и опирается.
 */
export interface InviteSignal {
  url: string;
  service: string | null;
  domain: string | null;
}

export interface ChatKind {
  kind: "invite" | "credential" | "task";
  service: string | null;
  serviceDomain: string | null;
}

const TASK: ChatKind = { kind: "task", service: null, serviceDomain: null };

const INVITE_WORDS = /приглашен|invitation|\binvited to\b|you(?:'|’)ve been invited|you have been invited/i;

function linkScore(raw: string): number {
  const path = raw.toLowerCase();
  if (/invit|join|accept|welcome|signup|sign-up|register|onboard/.test(path)) return 2;
  if (/unsubscribe|privacy|terms|help|support|blog|pricing/.test(path)) return -1;
  return 0;
}

/** Ссылка, по которой принимают приглашение: с домена сервиса, лучше с invite/join в пути. */
export function pickInviteLink(links: string[], domain: string | null): string | null {
  const clean = links.filter((l) => /^https?:\/\//i.test(l) && !isNoiseDomain(hostOf(l)));
  const own = domain ? clean.filter((l) => sameBrand(hostOf(l), domain)) : clean;
  const pool = own.length ? own : clean;
  return [...pool].sort((a, b) => linkScore(b) - linkScore(a))[0] ?? null;
}

/** Путь или query именно про вход по приглашению, а не документация со словом register. */
export function isInviteUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (isNoiseDomain(url.hostname)) return false;
  const path = url.pathname.toLowerCase();
  const query = url.search.toLowerCase();
  if (/[?&](?:invite|invitation)=/.test(query)) return true;
  if (/(?:^|\/)(?:invite|invitation|join|accept|onboard)(?:\/|$)/.test(path)) return true;
  if (/^\/(?:register|signup|sign-up|welcome)\/?$/.test(path)) return true;
  return false;
}

function serviceFromText(text: string): string | null {
  const patterns = [
    /приглашени[ея]\s+в\s+([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 .+-]{0,40})/i,
    /invitation to\s+([A-Za-z0-9][\w .+-]{0,40})/i,
    /invited to\s+(?:join\s+)?([A-Za-z0-9][\w .+-]{0,40})/i,
  ];
  for (const pattern of patterns) {
    const name = text.match(pattern)?.[1]?.split(/[,.!?\n]/)[0]?.trim();
    if (name && name.length >= 2 && !/^(the|our|a|an|your|this)$/i.test(name)) return name;
  }
  return null;
}

function brandFromDomain(domain: string): string | null {
  const label = domain.split(".")[0] ?? "";
  if (label.length < 2) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function inviteSignal(text: string, links: string[]): InviteSignal | null {
  const shaped = links.filter(isInviteUrl);
  let url = shaped.length ? pickInviteLink(shaped, null) : null;
  if (!url && INVITE_WORDS.test(text)) {
    const candidate = pickInviteLink(links, null);
    if (candidate && linkScore(candidate) >= 0) url = candidate;
  }
  if (!url) return null;
  const domain = rootDomain(hostOf(url));
  return {
    url,
    service: serviceFromText(text) ?? brandFromDomain(domain),
    domain: domain.includes(".") ? domain : null,
  };
}

/** Сообщение почти целиком состоит из ссылки приглашения: отдельной задачи в тексте нет. */
export function bareInvite(text: string, links: string[]): InviteSignal | null {
  const signal = inviteSignal(text, links);
  if (!signal) return null;
  const rest = text.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  if (rest.length > 48) return null;
  return signal;
}

/**
 * Пустой или упавший классификатор не отменяет приглашение.
 * Короткое сообщение со ссылкой приглашения — тоже приглашение, даже если модель сказала «задача»:
 * иначе ход заканчивается фразой «вхожу через браузер» и браузер не открывается.
 */
export function coerceChatClassification(parsed: ChatKind | null, message: string, links: string[]): ChatKind {
  const signal = inviteSignal(message, links);
  if (!parsed) {
    if (!signal) return TASK;
    return { kind: "invite", service: signal.service, serviceDomain: signal.domain };
  }
  if (parsed.kind === "invite") {
    return {
      kind: "invite",
      service: parsed.service ?? signal?.service ?? null,
      serviceDomain: parsed.serviceDomain ?? signal?.domain ?? null,
    };
  }
  if (parsed.kind === "credential") return parsed;
  const bare = bareInvite(message, links);
  if (!bare) return parsed;
  return { kind: "invite", service: bare.service, serviceDomain: bare.domain };
}

export function emailInviteFallback(
  subject: string,
  body: string,
  links: string[],
): { kind: "invite"; service: string | null; serviceDomain: string | null; summary: string; hasLoginLink: boolean } | null {
  const signal = inviteSignal(`${subject}\n${body}`, links);
  if (!signal) return null;
  return {
    kind: "invite",
    service: signal.service,
    serviceDomain: signal.domain,
    summary: subject || "Приглашение",
    hasLoginLink: true,
  };
}
