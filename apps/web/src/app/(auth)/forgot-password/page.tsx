import { ForgotPasswordForm } from "@/components/password-reset-forms";

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  return <ForgotPasswordForm initialEmail={email ?? ""} />;
}
