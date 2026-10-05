import type { Run, ServiceCredential, ServiceRecipe } from "@swarm/contracts";
import type { AcceptInviteResult } from "./browser/invite";
import { generatePassword } from "./browser/invite";
import { applyStorageToProfile, type BrowserStorageState } from "./browser/session-transfer";
import { chromeAvailable, chromeExecutable, isOwnBrowser, serviceProfileDir } from "./browser/stagehand";
import {
  API_KEY_SCHEMA,
  apiKeyPrompt,
  blockerKind,
  credentialHostAllowed,
  decideConnection,
  OWNER_OUTAGE,
  interpretApiKeyOutput,
  looksLikeServiceApprovalWait,
  proofUrls,
  proveApiKey,
  readPagePrompt,
  recipeAuth,
  type ConnectDecision,
  type Proof,
} from "./connect";
import { mcpToolNames, type DiscoveryResult } from "./discovery";
import { hostOf, isNoiseDomain, matchRecipe, pickServiceDomain, rootDomain, slugFor } from "./domains";
import { isInviteUrl, pickInviteLink } from "./invite-signal";
import { connectedFollowupPrompt, humanPage, secretFollowupPrompt, type KnownRecipeRef } from "./prompts";
import type { AgentRuntime } from "./runtime";
import type { HandoffContext, ResumeConnect } from "./runtime/handoffs";
import { finishServiceThink } from "./service-work";
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
  /** Свой браузер на машине есть всегда: им работают внутри сервиса и повторяют вход. */
  browserAvailable: boolean;
  /** Slug сервиса, даже если рецепта ещё нет. */
  slug: string | null;
  /** Чем кончился сам движок, до хода Hermes. */
  engine: EngineResult;
}

export interface EngineResult {
  status: "ready" | "needs_secret" | "escalated" | "ignored" | "failed";
  mode: "mcp" | "api" | "browser" | null;
  reason: string;
  liveUrl: string | null;
  /** Карточка «нужен человек» уже в чате: вызывающему не надо писать второе сообщение. */
  handoffId: string | null;
}

export interface OnboardingInput {
  service: string | null;
  domain: string | null;
  links: string[];
  /** Дополнительные хосты для поиска рецепта: DKIM-домены письма. */
  extraHosts?: string[];
}

export { pickInviteLink } from "./invite-signal";

export async function prepareOnboarding(rt: AgentRuntime, run: Run, input: OnboardingInput): Promise<OnboardingContext> {
  const hosts = [...input.links.map(hostOf), ...(input.extraHosts ?? []), input.domain ?? ""].filter(Boolean);
  const known = await rt.services.knownRecipe(hosts);
  const recipe: KnownRecipeRef | null = known ? { slug: known.slug, name: known.name, kind: known.kind } : null;

  let discovery: DiscoveryResult | null = null;
  if (!recipe) {
    try {
      discovery = await rt.research.discover(run, { service: input.service, domain: input.domain, links: input.links });
    } catch (e) {
      warn("onboarding", "поиск сервиса не удался", { error: String(e) });
    }
  }

  const domain = discovery?.domain ?? pickServiceDomain(input.domain, input.links) ?? known?.domains[0] ?? null;
  const slug = recipe?.slug ?? discovery?.slug ?? slugFor(domain, input.service);
  const service = recipe?.name ?? discovery?.service ?? input.service ?? slug;
  const recipeKind: "mcp" | "api" | null =
    recipe?.kind === "mcp" || discovery?.mcp?.verified
      ? "mcp"
      : recipe?.kind === "api" || discovery?.api?.baseUrl
        ? "api"
        : null;
  const inviteUrl = pickInviteLink(input.links, domain);

  let invite: AcceptInviteResult | null = null;
  let inviteSkipped: string | null = null;
  let engine: EngineResult;
  if (!inviteUrl) {
    inviteSkipped = "в приглашении нет ссылки";
    engine = { status: "ignored", mode: null, reason: inviteSkipped, liveUrl: null, handoffId: null };
  } else if (!rt.browser.canOnboard) {
    inviteSkipped = "браузер не настроен";
    engine = { status: "failed", mode: null, reason: inviteSkipped, liveUrl: null, handoffId: null };
  } else {
    const connected = await connectInvite(rt, run, { url: inviteUrl, slug, service, discovery, recipeKind }, null);
    invite = connected.invite;
    engine = connected.engine;
    if (invite && invite.status !== "accepted") inviteSkipped = invite.notes;
  }

  return { recipe, discovery, inviteUrl, invite, inviteSkipped, browserAvailable: rt.browser.available, slug, engine };
}

/** Человек нажал «я доделал»: тот же конвейер, та же сессия, тот же пароль. */
export const resumeConnect: ResumeConnect = async (rt, run, ctx) => {
  const snap = ctx.serviceWait ? await rt.store.readServices() : null;
  const recipe = snap?.recipes.find((r) => r.slug === ctx.slug) ?? null;
  const url = resumeTarget(ctx, recipe);
  if (ctx.serviceWait && url !== ctx.url) {
    await rt.step(run.id, "note", "заявка одобрена, вхожу на страницу сервиса сохранённым паролем");
  }
  const { engine } = await connectInvite(
    rt,
    run,
    { url, slug: ctx.slug, service: ctx.service, discovery: ctx.discovery, recipeKind: null },
    { provider: ctx.provider, browserSessionId: ctx.browserSessionId, password: ctx.password, serviceWait: ctx.serviceWait },
  );
  return engine;
};

/**
 * После одобрения заявки ссылка приглашения уже потрачена.
 * Открываем корень страницы, на которой заявка была отправлена, того же сервиса.
 */
export function loginAfterApproval(inviteUrl: string, finalUrl: string | null | undefined): string {
  const originOnService = (raw: string | null | undefined): string | null => {
    if (!raw || !/^https?:\/\//i.test(raw)) return null;
    if (isNoiseDomain(hostOf(raw))) return null;
    if (!credentialHostAllowed(raw, [inviteUrl])) return null;
    return originOf(raw);
  };
  return originOnService(finalUrl) ?? originOnService(inviteUrl) ?? inviteUrl;
}

/** Куда открывать браузер: обычный повтор идёт по ссылке приглашения, ожидание заявки — на страницу сервиса. */
export function resumeTarget(
  ctx: { serviceWait?: boolean | undefined; url: string; loginUrl?: string | null | undefined },
  recipe: { browser?: { loginUrl: string; appUrl: string } | undefined } | null,
): string {
  if (!ctx.serviceWait) return ctx.url;
  const stored = appOrigin(ctx.loginUrl, ctx.url);
  if (stored) return stored;
  const app = appOrigin(recipe?.browser?.appUrl, ctx.url);
  if (app) return app;
  const login = recipe?.browser?.loginUrl;
  if (login && /^https?:\/\//i.test(login) && !isInviteUrl(login) && credentialHostAllowed(login, [ctx.url])) return login;
  return loginAfterApproval(ctx.url, null);
}

function appOrigin(raw: string | null | undefined, inviteUrl: string): string | null {
  if (!raw || !/^https?:\/\//i.test(raw) || isInviteUrl(raw) || isNoiseDomain(hostOf(raw))) return null;
  if (!credentialHostAllowed(raw, [inviteUrl])) return null;
  return originOf(raw);
}

async function storedPassword(rt: AgentRuntime, slug: string, inviteUrl: string): Promise<string | null> {
  const snap = await rt.store.readServices();
  if (!snap) return null;
  const host = hostOf(inviteUrl);
  const known = matchRecipe(snap.recipes, [host, rootDomain(host)]);
  const cred = snap.credentials.find((c) => c.slug === (known?.slug ?? slug));
  return cred?.password ?? null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin + "/";
  } catch {
    return null;
  }
}

interface ResumeArgs {
  provider: "skyvern" | "local";
  browserSessionId: string | null;
  password: string | null;
  serviceWait?: boolean | undefined;
}

async function recipeKindOf(rt: AgentRuntime, args: ConnectArgs): Promise<"mcp" | "api" | null> {
  if (args.recipeKind) return args.recipeKind;
  const snap = await rt.store.readServices();
  const known = snap ? matchRecipe(snap.recipes, [hostOf(args.url), rootDomain(hostOf(args.url)), args.slug]) : null;
  if (known?.kind === "mcp" || known?.kind === "api") return known.kind;
  if (args.discovery?.mcp?.verified) return "mcp";
  if (args.discovery?.api?.baseUrl) return "api";
  return null;
}

/** Пароль есть, а рецепт требует токен или ключ, которого этот прогон не доказал. */
async function needsSecret(rt: AgentRuntime, args: ConnectArgs, mode: ConnectDecision["mode"]): Promise<boolean> {
  const kind = await recipeKindOf(rt, args);
  if (kind === "mcp") return mode !== "mcp";
  if (kind === "api") return mode !== "api";
  return false;
}

interface ConnectArgs {
  url: string;
  slug: string;
  service: string;
  discovery: DiscoveryResult | null;
  /** Рецепт каталога или находка поиска. null — ещё не знаем, connectInvite посмотрит каталог сам. */
  recipeKind: "mcp" | "api" | null;
}

/**
 * Регистрация и поиск ключа в одной сессии браузера. Готово — только MCP с инструментами,
 * доказанный API-вызов или пароль, которым можно войти снова. Барьер в продукте оставляет
 * браузер открытым и вешает в чат карточку «нужен человек» с кнопками.
 */
async function connectInvite(
  rt: AgentRuntime,
  run: Run,
  args: ConnectArgs,
  resume: ResumeArgs | null,
): Promise<{ invite: AcceptInviteResult | null; engine: EngineResult }> {
  const stored = await storedPassword(rt, args.slug, args.url);
  const typed = resume?.password ?? stored ?? generatePassword();
  // Повтор после капчи — аккаунт уже заводили. Заявка без пароля ещё не аккаунт: не входить выдуманным паролем.
  const existing = Boolean(resume?.password ?? stored) || (resume !== null && !resume.serviceWait);

  const escalate = async (
    decision: ConnectDecision,
    invite: AcceptInviteResult | null,
    ctx: Omit<HandoffContext, "url" | "slug" | "service" | "discovery">,
  ): Promise<{ invite: AcceptInviteResult | null; engine: EngineResult }> => {
    const handoff = decision.status === "escalated" && (decision.park || (!decision.closeBrowser && ctx.browserSessionId));
    if (handoff) {
      const serviceWait = decision.park;
      const page = serviceWait ? null : humanPage(ctx.liveUrl);
      const reason = serviceWait
        ? `Заявка на регистрацию в ${args.service} отправлена с ${rt.cfg.email}. Одобрите её в сервисе. Когда одобрите — нажмите «Одобрил, продолжай»: я войду и подключусь. Письмо сервиса на эту почту продолжит вход само.`
        : page
          ? `${decision.reason} Откройте страницу и доделайте шаг за ${rt.cfg.email}: ${page} Что агент уже видел — скриншотами в карточке браузера выше.`
          : decision.reason;
      const pending = await rt.handoffs.open(
        run,
        reason,
        {
          ...ctx,
          password: serviceWait ? (invite?.password ?? null) : ctx.password,
          liveUrl: serviceWait ? null : ctx.liveUrl,
          loginUrl: serviceWait ? loginAfterApproval(args.url, invite?.finalUrl) : null,
          serviceWait,
          url: args.url,
          slug: args.slug,
          service: args.service,
          discovery: args.discovery,
        },
      );
      return { invite, engine: { ...toEngine({ ...decision, reason }, serviceWait ? null : ctx.liveUrl), handoffId: pending.id } };
    }
    const engine = toEngine(decision, decision.closeBrowser ? null : ctx.liveUrl);
    if (decision.status === "ready" && (await needsSecret(rt, args, decision.mode))) {
      engine.status = "needs_secret";
      engine.mode = (await recipeKindOf(rt, args)) === "api" ? "api" : "mcp";
    }
    return { invite, engine };
  };

  // Повтор после своего браузера остаётся в нём: Skyvern эту сессию не продолжает.
  if (rt.skyvern && !isOwnBrowser(resume?.provider)) {
    const skyvern = rt.skyvern;
    const reuse = resume?.provider === "skyvern" && resume.browserSessionId && skyvern.sessionAlive(resume.browserSessionId) ? resume.browserSessionId : null;
    let sessionId: string | null = null;
    const close = async () => {
      if (!sessionId) return;
      const id = sessionId;
      sessionId = null;
      await skyvern.closeBrowserSession(id);
    };
    try {
      const session = reuse ? { browserSessionId: reuse, liveUrl: null as string | null } : await skyvern.openBrowserSession();
      sessionId = session.browserSessionId;
      if (resume && !reuse) await rt.step(run.id, "note", "прежняя сессия браузера уже закрыта, вхожу заново");
      const invite = await skyvern.acceptInvite({
        runId: run.id,
        url: args.url,
        service: args.service,
        agentName: rt.cfg.agentName,
        email: rt.cfg.email,
        password: typed,
        existing,
        browserSessionId: session.browserSessionId,
        onSession: (s) => rt.announceBrowser(run, s),
        onStep: (text, data) => rt.step(run.id, "browser", text, data),
      });
      const liveUrl = invite.liveUrl ?? session.liveUrl;
      const handoffCtx = { provider: "skyvern" as const, browserSessionId: session.browserSessionId, password: typed, liveUrl };
      if (invite.status !== "accepted" || looksLikeServiceApprovalWait(invite.notes)) {
        const barrier = looksLikeServiceApprovalWait(invite.notes) ? "pending_approval" : blockerKind(invite.barrierKind);
        // Skyvern как инструмент не довёл вход. Истёкшее приглашение своим браузером не починить.
        if (invite.status === "failed" && invite.barrierKind !== "invite_spent" && barrier !== "pending_approval" && rt.browser.available) {
          await close();
          await rt.step(run.id, "note", "Повторяю вход.");
        } else {
          const decision = decideConnection({
            onboard: invite.status === "failed" && invite.barrierKind !== "invite_spent" && barrier !== "pending_approval" ? "failed" : "blocked",
            inviteUrl: args.url,
            landedUrl: invite.finalUrl,
            passwordTyped: Boolean(invite.password),
            password: barrier === "pending_approval" ? invite.password : null,
            barrierKind: barrier ?? (invite.status === "needs_human" ? "other" : null),
            notes: invite.notes,
            apiBaseUrl: null,
            apiKeyUsable: false,
            proof: "not_tried",
            mcpReady: false,
          });
          if (decision.closeBrowser) await close();
          return escalate(decision, invite, handoffCtx);
        }
      } else {
        const landed = invite.finalUrl || args.url;
        let sought = {
          token: null as string | null,
          proof: "not_tried" as Proof,
          baseUrl: args.discovery?.api?.baseUrl ?? null,
          authHeader: args.discovery?.api?.authHeader ?? null,
          docsUrl: args.discovery?.api?.docsUrl ?? null,
          notes: "",
        };
        try {
          sought = await seekApiKey(rt, run, session.browserSessionId, args, landed);
        } catch (e) {
          warn("onboarding", "поиск ключа не удался", { error: String(e) });
          await rt.step(run.id, "error", `поиск ключа не удался: ${String(e)}`);
        }
        const mcpReady = await mcpIsReady(args.discovery, sought.token, sought.proof).catch(() => false);
        // После handoff пароль печатал человек: мы дали ему тот же, считаем, что он его и поставил.
        const password = invite.password ?? (resume ? typed : null);
        if (looksLikeServiceApprovalWait(sought.notes)) {
          const decision = decideConnection({
            onboard: "blocked",
            inviteUrl: args.url,
            landedUrl: landed,
            passwordTyped: Boolean(invite.password),
            password,
            barrierKind: "pending_approval",
            notes: sought.notes,
            apiBaseUrl: null,
            apiKeyUsable: false,
            proof: "not_tried",
            mcpReady: false,
          });
          if (decision.closeBrowser) await close();
          return escalate(decision, invite, handoffCtx);
        }
        const decision = decideConnection({
          onboard: "landed",
          inviteUrl: args.url,
          landedUrl: landed,
          passwordTyped: Boolean(invite.password),
          password,
          barrierKind: null,
          notes: invite.notes,
          apiBaseUrl: sought.baseUrl,
          apiKeyUsable: Boolean(sought.token),
          proof: sought.proof,
          mcpReady,
        });
        let cookiesInProfile = false;
        cookiesInProfile = await transferSkyvernCookies(rt, run, skyvern, session.browserSessionId, args.slug);
        invite.cookiesInProfile = cookiesInProfile;
        if (decision.status === "ready") {
          await persistConnection(rt, run, {
            slug: args.slug,
            service: args.service,
            domain: rootDomain(hostOf(args.url)),
            mode: decision.mode ?? "browser",
            password: decision.savePassword ? password : null,
            token: decision.saveToken ? sought.token : null,
            baseUrl: sought.baseUrl,
            authHeader: sought.authHeader,
            docsUrl: sought.docsUrl,
            loginUrl: args.url,
            appUrl: originOf(landed) ?? originOf(args.url) ?? args.url,
            cookiesInProfile,
          });
        }
        if (decision.closeBrowser) await close();
        await rt.step(run.id, "note", decision.reason);
        return escalate(decision, invite, handoffCtx);
      }
    } catch (e) {
      warn("onboarding", "Skyvern не довёл подключение", { error: String(e) });
      await close();
      if (!rt.browser.available) {
        const decision = decideConnection({
          onboard: "runtime",
          inviteUrl: args.url,
          landedUrl: "",
          passwordTyped: false,
          password: null,
          barrierKind: null,
          notes: OWNER_OUTAGE,
          apiBaseUrl: null,
          apiKeyUsable: false,
          proof: "not_tried",
          mcpReady: false,
        });
        return { invite: null, engine: toEngine(decision, null) };
      }
      await rt.step(run.id, "note", "Повторяю вход своим браузером.");
    }
  }

  // Свой браузер: cookies в профиле сервиса, после handoff входим заново.
  if (isOwnBrowser(resume?.provider) && resume?.browserSessionId) await rt.browser.close(resume.browserSessionId);
  try {
    const invite = await rt.browser.acceptInvite(
      run,
      { url: args.url, slug: args.slug, service: args.service },
      { persist: false, skipSkyvern: true, password: typed, existing },
    );
    const pending = invite.barrierKind === "pending_approval" || looksLikeServiceApprovalWait(invite.notes);
    const landed = invite.status === "accepted" && !pending;
    const password = landed || pending ? (invite.password ?? stored ?? (resume ? typed : null)) : null;
    const decision = decideConnection({
      onboard: landed ? "landed" : "blocked",
      inviteUrl: args.url,
      landedUrl: invite.finalUrl,
      passwordTyped: Boolean(invite.password),
      password,
      barrierKind: pending ? "pending_approval" : landed ? null : (blockerKind(invite.barrierKind) ?? "other"),
      notes: invite.notes,
      apiBaseUrl: args.discovery?.api?.baseUrl ?? null,
      apiKeyUsable: false,
      proof: "not_tried",
      mcpReady: false,
    });
    if (decision.status === "ready") {
      await persistConnection(rt, run, {
        slug: args.slug,
        service: args.service,
        domain: rootDomain(hostOf(args.url)),
        mode: "browser",
        password: decision.savePassword ? password : null,
        token: null,
        baseUrl: null,
        authHeader: null,
        docsUrl: null,
        loginUrl: args.url,
        appUrl: originOf(invite.finalUrl) ?? originOf(args.url) ?? args.url,
        cookiesInProfile: true,
      });
      invite.cookiesInProfile = true;
    }
    if (decision.closeBrowser && invite.browserSessionId) await rt.browser.close(invite.browserSessionId);
    await rt.step(run.id, "note", decision.reason);
    return escalate(decision, invite, {
      provider: "local",
      browserSessionId: invite.browserSessionId ?? null,
      password: invite.password ?? stored ?? null,
      liveUrl: invite.liveUrl ?? null,
    });
  } catch (e) {
    warn("onboarding", "принять приглашение не удалось", { error: String(e) });
    await rt.step(run.id, "error", OWNER_OUTAGE);
    return {
      invite: { status: "failed", accountEmail: rt.cfg.email, password: null, steps: 0, finalUrl: "", notes: OWNER_OUTAGE },
      engine: { status: "failed", mode: null, reason: OWNER_OUTAGE, liveUrl: null, handoffId: null },
    };
  }
}

function toEngine(decision: ConnectDecision, liveUrl: string | null): EngineResult {
  return { status: decision.status, mode: decision.mode, reason: decision.reason, liveUrl, handoffId: null };
}

async function seekApiKey(
  rt: AgentRuntime,
  run: Run,
  browserSessionId: string,
  args: { service: string; discovery: DiscoveryResult | null },
  landedUrl: string,
): Promise<{ token: string | null; proof: Proof; baseUrl: string | null; authHeader: string | null; docsUrl: string | null; notes: string }> {
  const skyvern = rt.skyvern;
  if (!skyvern) return { token: null, proof: "not_tried", baseUrl: null, authHeader: null, docsUrl: null, notes: "" };
  const hinted = args.discovery?.api?.keyPageUrl ?? null;
  const baseUrl = args.discovery?.api?.baseUrl ?? null;
  const authHeader = args.discovery?.api?.authHeader || null;
  const docsUrl = args.discovery?.api?.docsUrl ?? null;
  const anchors = [landedUrl, hinted, baseUrl, docsUrl].filter((u): u is string => Boolean(u));
  const start = hinted && credentialHostAllowed(hinted, anchors) ? hinted : landedUrl;

  let feedback: string | null = null;
  let forceRead = false;
  let token: string | null = null;
  let notes = "";
  for (let i = 0; i < 3 && !token; i++) {
    const prompt = forceRead ? readPagePrompt() : apiKeyPrompt({ agentName: rt.cfg.agentName, keyPageUrl: hinted, feedback });
    forceRead = false;
    feedback = null;
    const extracted = await skyvern.extract({
      runId: run.id,
      url: start,
      prompt,
      purpose: `найти API-ключ ${args.service}`,
      schema: API_KEY_SCHEMA,
      browserSessionId,
      maxSteps: i === 0 ? 20 : 8,
      onStep: (text, data) => rt.step(run.id, "browser", text, data),
    });
    if (extracted.status !== "completed") {
      notes = extracted.failureReason ?? extracted.status;
      break;
    }
    if (extracted.output == null) {
      forceRead = true;
      continue;
    }
    const parsed = interpretApiKeyOutput(extracted.output);
    notes = parsed.notes;
    if (parsed.found && parsed.apiKey) {
      token = parsed.apiKey;
      break;
    }
    if (parsed.rejectReason) feedback = `значение отклонено: ${parsed.rejectReason}`;
  }
  if (notes) await rt.step(run.id, "note", notes.slice(0, 300));

  const proveUrls = proofUrls(args.discovery?.api?.readEndpoints ?? [], baseUrl).filter((u) => credentialHostAllowed(u, anchors));
  if (!token || !authHeader || !proveUrls.length) {
    return { token, proof: token ? "not_tried" : "not_tried", baseUrl, authHeader, docsUrl, notes };
  }
  const proof = await proveApiKey({ urls: proveUrls, headerName: authHeader, token });
  await rt.step(run.id, "api", proof.detail);
  return { token, proof: proof.verdict, baseUrl, authHeader, docsUrl, notes };
}

async function mcpIsReady(discovery: DiscoveryResult | null, token: string | null, proof: Proof): Promise<boolean> {
  const mcp = discovery?.mcp;
  if (!mcp?.verified) return false;
  const bearer = mcp.auth === "none" ? undefined : proof === "green" && token ? token : undefined;
  if (mcp.auth !== "none" && !bearer) return false;
  const names = await mcpToolNames(mcp.url, fetch, bearer);
  return (names?.length ?? 0) > 0;
}

async function persistConnection(
  rt: AgentRuntime,
  run: Run,
  args: {
    slug: string;
    service: string;
    domain: string;
    mode: "mcp" | "api" | "browser";
    password: string | null;
    token: string | null;
    baseUrl: string | null;
    authHeader: string | null;
    docsUrl: string | null;
    loginUrl: string;
    appUrl: string;
    cookiesInProfile?: boolean;
  },
): Promise<void> {
  const domains = args.domain ? [args.domain] : [];
  const browser = /^https?:\/\//i.test(args.loginUrl) && /^https?:\/\//i.test(args.appUrl) ? { loginUrl: args.loginUrl, appUrl: args.appUrl } : undefined;
  if (args.mode === "api" && args.baseUrl) {
    const auth = recipeAuth(args.authHeader);
    const recipe: ServiceRecipe = {
      slug: args.slug,
      name: args.service,
      kind: "api",
      domains,
      api: {
        baseUrl: args.baseUrl,
        auth: auth.auth,
        authHeader: auth.authHeader,
        ...(args.docsUrl ? { docsUrl: args.docsUrl } : {}),
      },
      ...(browser ? { browser } : {}),
      notes: "Ключ доказан вызовом во время онбординга.",
      discoveredBy: rt.cfg.agentId,
    };
    await rt.services.applyReport({ type: "recipe", recipe, runId: run.id });
  } else if (args.mode === "browser") {
    const known = (await rt.store.readServices())?.recipes.some((r) => r.slug === args.slug) ?? false;
    if (!known && browser) {
      const recipe: ServiceRecipe = {
        slug: args.slug,
        name: args.service,
        kind: "browser",
        domains,
        browser,
        notes: "Вход по паролю. Программный доступ вызовом не доказан.",
        discoveredBy: rt.cfg.agentId,
      };
      await rt.services.applyReport({ type: "recipe", recipe, runId: run.id });
    }
  }
  const storageState = args.cookiesInProfile ? { provider: "local" as const, profile: args.slug } : undefined;
  const credential: ServiceCredential = {
    slug: args.slug,
    kind: args.mode,
    accountEmail: rt.cfg.email,
    accountName: rt.cfg.agentName,
    ...(args.password ? { password: args.password } : {}),
    ...(args.token && args.mode !== "browser" ? { token: args.token } : {}),
    ...(storageState ? { storageState } : {}),
  };
  await rt.services.applyReport({ type: "credential", credential, runId: run.id });
}

/**
 * Cookies из живой сессии Skyvern → browser-profiles/<slug>.
 * Ошибка не валит онбординг: остаётся вход по паролю.
 */
async function transferSkyvernCookies(
  rt: AgentRuntime,
  run: Run,
  skyvern: { exportStorageState: (id: string) => Promise<BrowserStorageState> },
  browserSessionId: string,
  slug: string,
): Promise<boolean> {
  if (!chromeAvailable()) {
    await rt.step(run.id, "note", "cookies Skyvern не перенесены: Chromium на машине нет");
    return false;
  }
  try {
    const state = await skyvern.exportStorageState(browserSessionId);
    await applyStorageToProfile({
      profileDir: serviceProfileDir(rt.store, slug),
      state,
      executablePath: chromeExecutable(),
    });
    await rt.step(run.id, "note", `cookies Skyvern перенесены в профиль ${slug}`);
    return true;
  } catch (e) {
    warn("onboarding", "перенос cookies Skyvern не удался", { error: String(e) });
    await rt.step(run.id, "note", `cookies Skyvern не перенесены: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Ход модели после входа. Если рецепту нужен токен — просим его достать.
 * Заявку на одобрение здесь не ловим: её уже решает движок до этого хода.
 * Текст модели не открывает карточку «Одобрил, продолжай».
 */
export async function runConnectFollowup(
  rt: AgentRuntime,
  run: Run,
  chatId: string,
  service: string,
  engine: { status: "ready" | "needs_secret"; mode: EngineResult["mode"] },
): Promise<void> {
  const prompt =
    engine.status === "needs_secret"
      ? secretFollowupPrompt(service, engine.mode === "api" ? "api" : "mcp")
      : connectedFollowupPrompt(service, engine.mode ?? "browser");
  const turn = await rt.think(run, prompt);
  const { text, status } = await finishServiceThink(rt, run, turn);
  if (status === "waiting_approval") return;
  await rt.finishRun(run, status, text);
  await rt.addChat({ role: "agent", text, runId: run.id, chatId });
}
