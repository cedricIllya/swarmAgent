import { randomBytes } from "node:crypto";

/**
 * Принять приглашение в сервис и зарегистрироваться под почтой агента.
 * Браузер — свой Chromium и Stagehand; коды и magic link приходят на почту агента, runtime
 * передаёт их в ту же сессию. Один цикл «посмотри страницу → сделай шаг».
 */

const PAGE_STATES = [
  "accept_button",
  "email_form",
  "signup_form",
  "password_form",
  "auth_choice",
  "code_prompt",
  "magic_link_sent",
  "logged_in",
  "captcha",
  "expired",
  "pending_approval",
  "account_exists",
  "password_rejected",
  "other",
] as const;

export type PageState = (typeof PAGE_STATES)[number];

export interface PageObservation {
  state: PageState;
  /** Что видно на странице: заголовок, главная кнопка, поля формы. */
  hint: string;
}

export const PAGE_STATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "hint"],
  properties: {
    state: { type: "string", enum: PAGE_STATES },
    hint: { type: "string" },
  },
} as const;

export const PAGE_STATE_INSTRUCTION = [
  "Определи, на каком шаге принятия приглашения находится страница. Верни state и hint.",
  "accept_button — видна кнопка принять приглашение / присоединиться / Accept / Join, без форм.",
  "email_form — просят только адрес электронной почты, полей имени и пароля на странице нет.",
  "signup_form — форма регистрации: есть имя и/или пароль (и, возможно, email). Если кроме почты видно имя или пароль — это signup_form, не email_form.",
  "password_form — просят только пароль для уже известного адреса.",
  "auth_choice — выбор способа входа: Google, Microsoft, SSO, email.",
  "code_prompt — просят ввести код подтверждения из письма.",
  "magic_link_sent — написано, что ссылка для входа отправлена на почту; поля для кода нет.",
  "logged_in — уже внутри приложения: рабочее пространство, меню, список проектов или задач.",
  "captcha — капча или проверка «я не робот».",
  "expired — приглашение недействительно, истекло или ошибка доступа.",
  "pending_approval — заявка на регистрацию отправлена и ждёт одобрения администратора сервиса. Подтверждение почты кодом или ссылкой — это не оно.",
  "account_exists — регистрация отвечает ошибкой: пользователь с этим адресом уже есть, email занят.",
  "password_rejected — форма входа показывает ошибку: неверный пароль, неверный логин или пароль.",
  "other — ничего из перечисленного.",
  "Если на форме видна красная ошибка — выбирай account_exists или password_rejected, а не форму, на которой она показана.",
].join("\n");

/** Минимальный интерфейс сессии, чтобы цикл можно было прогнать без браузера. */
export interface InviteBrowser {
  goto(url: string): Promise<void>;
  act(instruction: string): Promise<{ success: boolean; message: string }>;
  extract(instruction: string, schema?: unknown): Promise<unknown>;
  waitForCode(timeoutMs: number): Promise<{ kind: "code" | "link"; value: string } | null>;
  currentUrl(): Promise<string>;
}

export interface AcceptInviteArgs {
  url: string;
  service: string;
  agentName: string;
  email: string;
  /** Пароль этого прогона. Для нового аккаунта его задают при регистрации и им же входят сразу после. */
  password?: string | null;
  /** Аккаунт в сервисе уже был: форму регистрации не заполнять, только войти. */
  existing?: boolean;
  maxSteps?: number;
  codeTimeoutMs?: number;
  onStep?: (text: string, data?: Record<string, unknown>) => Promise<void> | void;
}

export interface AcceptInviteResult {
  status: "accepted" | "needs_human" | "failed";
  accountEmail: string;
  /** Пароль, который задали при регистрации; null — вход был по коду или ссылке. */
  password: string | null;
  steps: number;
  finalUrl: string;
  notes: string;
  /** Кто принимал приглашение: Skyvern или свой Chromium. */
  provider?: "skyvern" | "local";
  /** Cookies лежат в browser-profiles/<slug> (свой браузер или перенос из Skyvern). */
  cookiesInProfile?: boolean;
  /** Закрытая причина барьера, если она из списка. Свободный текст остаётся в notes. */
  barrierKind?: string | null;
  liveUrl?: string | null;
  browserSessionId?: string | null;
}

export function generatePassword(): string {
  // base64url даёт буквы обоих регистров и цифры; хвост закрывает требования к спецсимволам.
  return `${randomBytes(12).toString("base64url")}!A9`;
}

function parseObservation(raw: unknown): PageObservation {
  const o = (raw ?? {}) as Partial<PageObservation>;
  return {
    state: (PAGE_STATES as readonly string[]).includes(o.state as string) ? (o.state as PageState) : "other",
    hint: typeof o.hint === "string" ? o.hint.slice(0, 200) : "",
  };
}

export async function acceptInvite(browser: InviteBrowser, args: AcceptInviteArgs): Promise<AcceptInviteResult> {
  const maxSteps = args.maxSteps ?? 14;
  const codeTimeout = args.codeTimeoutMs ?? 5 * 60 * 1000;
  const step = async (text: string, data?: Record<string, unknown>) => args.onStep?.(text, data);
  let password = args.password ?? null;
  let passwordCreated = false;
  let lastState: PageState | null = null;
  let repeats = 0;
  let waitedForCode = 0;
  let extractFailures = 0;
  let accountExistsSeen = false;

  const finish = async (
    status: AcceptInviteResult["status"],
    steps: number,
    notes: string,
    barrierKind: string | null = null,
  ): Promise<AcceptInviteResult> => ({
    status,
    accountEmail: args.email,
    password: passwordCreated ? password : null,
    steps,
    finalUrl: await browser.currentUrl().catch(() => ""),
    notes,
    provider: "local",
    barrierKind,
  });

  await browser.goto(args.url);
  await step(`открыл приглашение в ${args.service}`);

  for (let i = 1; i <= maxSteps; i++) {
    let raw: unknown;
    try {
      raw = await browser.extract(PAGE_STATE_INSTRUCTION, PAGE_STATE_SCHEMA);
      extractFailures = 0;
    } catch (e) {
      extractFailures++;
      await step(`шаг ${i}: страницу не удалось разобрать`, { error: String(e).slice(0, 300) });
      if (extractFailures >= 2) return finish("failed", i, "страницу не удалось разобрать два раза подряд");
      continue;
    }
    const seen = parseObservation(raw);
    await step(`шаг ${i}: ${seen.state}${seen.hint ? ` — ${seen.hint}` : ""}`);

    repeats = seen.state === lastState ? repeats + 1 : 0;
    lastState = seen.state;
    if (repeats >= 3) return finish("failed", i, `страница не меняется: ${seen.state}. ${seen.hint}`);

    switch (seen.state) {
      case "logged_in":
        return finish("accepted", i, `приглашение принято, аккаунт ${args.email}`);

      case "captcha":
        return finish("needs_human", i, `капча: ${seen.hint}`, "captcha");

      case "expired":
        return finish("failed", i, `приглашение недействительно: ${seen.hint}`, "invite_spent");

      case "pending_approval":
        return finish("needs_human", i, `заявка ждёт одобрения в сервисе: ${seen.hint}`, "pending_approval");

      case "password_rejected":
        return finish("needs_human", i, `сервис не принял пароль для ${args.email}: ${seen.hint}`, "password_rejected");

      case "account_exists": {
        if (accountExistsSeen) {
          return finish("needs_human", i, `аккаунт ${args.email} уже есть в ${args.service}, а войти в него нечем: ${seen.hint}`, "password_rejected");
        }
        accountExistsSeen = true;
        if (!args.existing) {
          // Пароль от аккаунта, заведённого раньше, агенту неизвестен: придуманный не подойдёт.
          password = null;
          passwordCreated = false;
        }
        await browser.act(
          [
            `Аккаунт ${args.email} уже есть. Перейди на страницу входа (Войти, Sign in, Log in) и введи этот адрес.`,
            password ? `Пароль — ${password}.` : "Выбери вход по коду на почту или magic link, если он есть.",
            "Не регистрируй новый аккаунт и не нажимай «забыли пароль».",
          ].join(" "),
        );
        break;
      }

      case "accept_button":
        await browser.act("Нажми кнопку принять приглашение или присоединиться (Accept, Join, Continue, Принять)");
        break;

      case "auth_choice":
        await browser.act("Выбери продолжить по электронной почте (Continue with email / Sign up with email), не Google, Microsoft или SSO");
        break;

      case "email_form":
        await browser.act(
          [
            `Введи адрес ${args.email} в поле почты.`,
            `Если на странице всё же есть имя, first name, last name или username — введи «${args.agentName}» сам, до отправки (одно слово — в оба поля).`,
            password
              ? `Если есть пароль или его подтверждение — введи ${password}. Форму с пустым именем или паролем не отправляй.`
              : "Поля пароля здесь быть не должно: если оно есть, не отправляй форму.",
            "Отправь форму (Continue, Next, Продолжить).",
          ].join(" "),
        );
        break;

      case "signup_form": {
        if (args.existing && password) {
          await browser.act(
            [
              `Это уже существующий аккаунт ${args.email}. Не регистрируй новый и не нажимай «забыли пароль».`,
              `Найди вход и войди: адрес ${args.email}, пароль ${password}. Если предлагают код на почту — предпочти его.`,
            ].join(" "),
          );
          break;
        }
        if (!password) password = generatePassword();
        passwordCreated = true;
        await browser.act(
          [
            `Заполни форму регистрации сам, до отправки: имя «${args.agentName}», адрес ${args.email}, пароль ${password}`,
            "(и подтверждение пароля, если есть). Одно слово имени — и в имя, и в фамилию. Пустыми имя и пароль не оставляй.",
            "Отметь согласие с условиями, если просят. Отправь форму только после этого.",
            "Если на этой же странице есть ссылка «уже есть аккаунт» или «войти» — не нажимай её: сначала регистрация.",
          ].join(" "),
        );
        break;
      }

      case "password_form": {
        if (!password) {
          const r = await browser.act(
            "Если есть вход по коду на почту или magic link — выбери его. Не нажимай «забыли пароль» и не меняй пароль.",
          );
          if (!r.success) return finish("needs_human", i, `просят пароль, а у агента его нет: ${seen.hint}`);
          break;
        }
        await browser.act(
          [
            `Введи пароль ${password} для ${args.email} и отправь форму.`,
            passwordCreated
              ? "Это вход сразу после регистрации: пароль тот же, который только что задали. Не регистрируй второй аккаунт."
              : "Если предлагают код на почту — предпочти его паролю.",
            "Не нажимай «забыли пароль» и не меняй пароль.",
          ].join(" "),
        );
        break;
      }

      case "code_prompt":
      case "magic_link_sent": {
        if (waitedForCode >= 2) return finish("failed", i, "код из письма так и не подошёл");
        waitedForCode++;
        await step("жду код или ссылку из письма");
        const got = await browser.waitForCode(codeTimeout);
        if (!got || !got.value) return finish("needs_human", i, "письмо с кодом не пришло вовремя");
        if (got.kind === "link") {
          await browser.goto(got.value);
          await step("перешёл по ссылке из письма");
        } else {
          await browser.act(`Введи код подтверждения ${got.value} и отправь форму`);
          await step("ввёл код из письма");
        }
        break;
      }

      case "other":
      default:
        await browser.act(`Продолжи принятие приглашения в ${args.service} от имени ${args.email}: нажми основную кнопку продолжения или закрой всплывающее окно`);
        break;
    }
  }

  return finish("failed", maxSteps, "не удалось завершить за отведённое число шагов");
}
