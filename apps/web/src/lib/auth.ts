import { createAuth, type Auth } from "@swarm/identity";
import { sendViaMailgun } from "@swarm/mail";
import { t } from "@/i18n";
import { env } from "@/env";
import { purgeUserSpaces } from "./delete-account";

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
    subject: t("mail.resetSubject"),
    text: [t("mail.resetIntro"), "", t("mail.resetLink", { url }), "", t("mail.resetIgnore")].join("\n"),
  });
}

export function auth(): Auth {
  if (!cached) {
    cached = createAuth({
      secret: env.authSecret,
      baseURL: env.appUrl,
      databaseUrl: env.databaseUrl,
      sendResetPassword,
      beforeDeleteUser: (user) => purgeUserSpaces(user.id),
    });
  }
  return cached;
}
