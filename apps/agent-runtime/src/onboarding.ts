import type { Run } from "@swarm/contracts";
import type { AcceptInviteResult } from "./browser/invite";
import type { DiscoveryResult } from "./discovery";
import { hostOf, isNoiseDomain, pickServiceDomain, sameBrand, slugFor } from "./domains";
import type { KnownRecipeRef } from "./prompts";
import type { AgentRuntime } from "./runtime";
import { warn } from "./log";

/**
 * Что runtime сделал с приглашением до первого хода модели:
 * нашёл рецепт или документацию, принял приглашение под почтой агента.
 */
export interface OnboardingContext {
  recipe: KnownRecipeRef | null;
  discovery: DiscoveryResult | null;
  inviteUrl: string | null;
  invite: AcceptInviteResult | null;
  /** Почему приглашение не принимали автоматически (нет браузера, нет ссылки). */
  inviteSkipped: string | null;
}

export interface OnboardingInput {
  service: string | null;
  domain: string | null;
  links: string[];
  /** Дополнительные хосты для поиска рецепта: DKIM-домены письма. */
  extraHosts?: string[];
}

/** Ссылка, по которой принимают приглашение: с домена сервиса, лучше с invite/join в пути. */
export function pickInviteLink(links: string[], domain: string | null): string | null {
  const clean = links.filter((l) => /^https?:\/\//i.test(l) && !isNoiseDomain(hostOf(l)));
  const own = domain ? clean.filter((l) => sameBrand(hostOf(l), domain)) : clean;
  const pool = own.length ? own : clean;
  const score = (l: string) => {
    const path = l.toLowerCase();
    if (/invit|join|accept|welcome|signup|sign-up|register|onboard/.test(path)) return 2;
    if (/unsubscribe|privacy|terms|help|support|blog|pricing/.test(path)) return -1;
    return 0;
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export async function prepareOnboarding(rt: AgentRuntime, run: Run, input: OnboardingInput): Promise<OnboardingContext> {
  const hosts = [...input.links.map(hostOf), ...(input.extraHosts ?? []), input.domain ?? ""].filter(Boolean);
  const known = await rt.knownRecipe(hosts);
  const recipe: KnownRecipeRef | null = known ? { slug: known.slug, name: known.name, kind: known.kind } : null;

  let discovery: DiscoveryResult | null = null;
  if (!recipe) {
    try {
      discovery = await rt.discover(run, { service: input.service, domain: input.domain, links: input.links });
    } catch (e) {
      warn("onboarding", "поиск сервиса не удался", { error: String(e) });
    }
  }

  const domain = discovery?.domain ?? pickServiceDomain(input.domain, input.links) ?? known?.domains[0] ?? null;
  const slug = recipe?.slug ?? discovery?.slug ?? slugFor(domain, input.service);
  const service = recipe?.name ?? discovery?.service ?? input.service ?? slug;
  const inviteUrl = pickInviteLink(input.links, domain);

  let invite: AcceptInviteResult | null = null;
  let inviteSkipped: string | null = null;
  if (!inviteUrl) {
    inviteSkipped = "в приглашении нет ссылки";
  } else if (!rt.browserAvailable) {
    inviteSkipped = "браузер не настроен";
  } else {
    try {
      invite = await rt.acceptInvite(run, { url: inviteUrl, slug, service });
    } catch (e) {
      warn("onboarding", "принять приглашение не удалось", { error: String(e) });
      await rt.step(run.id, "error", `принять приглашение не удалось: ${String(e)}`);
      invite = { status: "failed", accountEmail: rt.cfg.email, password: null, steps: 0, finalUrl: "", notes: String(e) };
    }
  }

  return { recipe, discovery, inviteUrl, invite, inviteSkipped };
}
