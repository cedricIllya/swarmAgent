import { AuthForm } from "@/components/auth-form";
import { t } from "@/i18n";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; deleted?: string }> }) {
  const { reset, deleted } = await searchParams;
  const notice = deleted ? t("auth.deletedNotice") : reset ? t("auth.resetNotice") : null;
  return <AuthForm mode="login" notice={notice} />;
}
