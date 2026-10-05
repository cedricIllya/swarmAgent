import { AuthForm } from "@/components/auth-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string; deleted?: string }> }) {
  const { reset, deleted } = await searchParams;
  const notice = deleted
    ? "Аккаунт удалён. Спасибо, что были с нами."
    : reset
      ? "Пароль изменён. Войдите с новым паролем."
      : null;
  return <AuthForm mode="login" notice={notice} />;
}
