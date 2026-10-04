import { createAuth, type Auth } from "@swarm/identity";
import { sendViaMailgun } from "@swarm/mail";
import { env } from "@/env";

let cached: Auth | null = null;

/** Без Mailgun ссылка уходит в лог сервера: её можно передать пользователю вручную. */
async function sendResetPassword({ email, url }: { email: string; name: string; url: string }): Promise<void> {
  const apiKey = env.mailgun.apiKey;
  if (!apiKey) {
    console.warn(`[auth] MAILGUN_API_KEY не задан, ссылка сброса пароля для ${email}: ${url}`);
    return;
  }
  const domain = env.agentsDomain;
  await sendViaMailgun({ apiKey, region: env.mailgun.region, domain }, `Swarm Agent <no-reply@${domain}>`, {
    to: email,
    subject: "Сброс пароля Swarm Agent",
    text: [
      "Кто-то запросил сброс пароля для этого адреса.",
      "",
      `Задать новый пароль: ${url}`,
      "",
      "Ссылка действует час. Если это были не вы, просто проигнорируйте письмо.",
    ].join("\n"),
  });
}

export function auth(): Auth {
  if (!cached) {
    cached = createAuth({
      secret: env.authSecret,
      baseURL: env.appUrl,
      databaseUrl: env.databaseUrl,
      sendResetPassword,
    });
  }
  return cached;
}
