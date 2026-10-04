import { AuthForm } from "@/components/auth-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const { reset } = await searchParams;
  return <AuthForm mode="login" notice={reset ? "Пароль изменён. Войдите с новым паролем." : null} />;
}
