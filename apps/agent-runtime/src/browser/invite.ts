import { randomBytes } from "node:crypto";

/**
 * Принять приглашение в сервис и зарегистрироваться под почтой агента.
 * Браузер — Stagehand; коды и magic link приходят на почту агента, runtime
 * передаёт их в ту же сессию. Один цикл «посмотри страницу → сделай шаг».
 */

export type PageState =
  | "accept_button"
  | "email_form"
  | "signup_form"
  | "password_form"
  | "auth_choice"
  | "code_prompt"
  | "magic_link_sent"
  | "logged_in"
  | "captcha"
  | "expired"
  | "other";

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
    state: {
      type: "string",
      enum: [
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
        "other",
      ],
    },
    hint: { type: "string" },
  },
} as const;

export const PAGE_STATE_INSTRUCTION = [
  "Определи, на каком шаге принятия приглашения находится страница. Верни state и hint.",
  "accept_button — видна кнопка принять приглашение / присоединиться / Accept / Join, без форм.",
  "email_form — просят только адрес электронной почты.",
  "signup_form — форма регистрации: имя и/или пароль (и, возможно, email).",
  "password_form — просят только пароль для уже известного адреса.",
  "auth_choice — выбор способа входа: Google, Microsoft, SSO, email.",
  "code_prompt — просят ввести код подтверждения из письма.",
  "magic_link_sent — написано, что ссылка для входа отправлена на почту; поля для кода нет.",
  "logged_in — уже внутри приложения: рабочее пространство, меню, список проектов или задач.",
  "captcha — капча или проверка «я не робот».",
  "expired — приглашение недействительно, истекло или ошибка доступа.",
  "other — ничего из перечисленного.",
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
  /** Пароль, если у агента уже есть аккаунт в сервисе. Иначе придумаем свой. */
  password?: string | null;
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
  /** Кто принимал приглашение: Skyvern или сессия Stagehand на Browserbase. */
  provider?: "skyvern" | "browserbase";
}

export function generatePassword(): string {
  // base64url даёт буквы обоих регистров и цифры; хвост закрывает требования к спецсимволам.
  return `${randomBytes(12).toString("base64url")}!A9`;
}

function parseObservation(raw: unknown): PageObservation {
  const o = (raw ?? {}) as Partial<PageObservation>;
  const states: PageState[] = [
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
    "other",
  ];
  return {
    state: states.includes(o.state as PageState) ? (o.state as PageState) : "other",
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

  const finish = async (status: AcceptInviteResult["status"], steps: number, notes: string): Promise<AcceptInviteResult> => ({
    status,
    accountEmail: args.email,
    password: passwordCreated ? password : null,
    steps,
    finalUrl: await browser.currentUrl().catch(() => ""),
    notes,
    provider: "browserbase",
  });

  await browser.goto(args.url);
  await step(`открыл приглашение в ${args.service}`);

  for (let i = 1; i <= maxSteps; i++) {
    const seen = parseObservation(await browser.extract(PAGE_STATE_INSTRUCTION, PAGE_STATE_SCHEMA));
    await step(`шаг ${i}: ${seen.state}${seen.hint ? ` — ${seen.hint}` : ""}`);

    repeats = seen.state === lastState ? repeats + 1 : 0;
    lastState = seen.state;
    if (repeats >= 3) return finish("failed", i, `страница не меняется: ${seen.state}. ${seen.hint}`);

    switch (seen.state) {
      case "logged_in":
        return finish("accepted", i, `приглашение принято, аккаунт ${args.email}`);

      case "captcha":
        return finish("needs_human", i, `капча: ${seen.hint}`);

      case "expired":
        return finish("failed", i, `приглашение недействительно: ${seen.hint}`);

      case "accept_button":
        await browser.act("Нажми кнопку принять приглашение или присоединиться (Accept, Join, Continue, Принять)");
        break;

      case "auth_choice":
        await browser.act("Выбери продолжить по электронной почте (Continue with email / Sign up with email), не Google, Microsoft или SSO");
        break;

      case "email_form":
        await browser.act(`Введи адрес ${args.email} в поле электронной почты и отправь форму (Continue, Next, Продолжить)`);
        break;

      case "signup_form": {
        if (!password) {
          password = generatePassword();
          passwordCreated = true;
        }
        await browser.act(
          [
            `Заполни форму регистрации: имя ${args.agentName}, адрес ${args.email}, пароль ${password}`,
            "(и подтверждение пароля, если есть). Отметь согласие с условиями, если просят. Отправь форму.",
          ].join(" "),
        );
        break;
      }

      case "password_form": {
        if (!password) {
          const r = await browser.act("Если есть вход по коду на почту или по ссылке (magic link, email me a code) — выбери его. Иначе нажми «забыли пароль»");
          if (!r.success) return finish("needs_human", i, `просят пароль, а у агента его нет: ${seen.hint}`);
          break;
        }
        await browser.act(`Введи пароль ${password} и отправь форму`);
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
