"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" style={{ marginBottom: 18 }}>
          <span className="brand-dot" />
          Swarm Agent
        </div>
        <h1 style={{ marginBottom: 6 }}>{title}</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 18 }}>
          {subtitle}
        </p>
        {children}
        <p className="muted small" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
          <Link href="/login">Вернуться ко входу</Link>
        </p>
      </div>
    </div>
  );
}

export function ForgotPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Не получилось");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <Shell title="Проверьте почту" subtitle={`Если аккаунт ${email} существует, мы отправили на него ссылку для нового пароля.`}>
        <p className="faint small" style={{ margin: 0 }}>
          Ссылка действует час. Письма нет — загляните в спам или запросите ещё раз.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Сброс пароля" subtitle="Пришлём ссылку, по которой можно задать новый пароль.">
      <form onSubmit={submit}>
        <div className="field">
          <label className="label">Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 6 }}>
          {busy ? "…" : "Отправить ссылку"}
        </button>
      </form>
    </Shell>
  );
}

export function ResetPasswordForm({ token, invalid }: { token: string | null; invalid: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (invalid || !token) {
    return (
      <Shell title="Ссылка недействительна" subtitle="Она устарела или уже использована.">
        <Link className="btn btn-primary" href="/forgot-password" style={{ width: "100%" }}>
          Запросить новую ссылку
        </Link>
      </Shell>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Не получилось");
      return;
    }
    router.push("/login?reset=1");
  }

  return (
    <Shell title="Новый пароль" subtitle="После смены все открытые сессии завершатся.">
      <form onSubmit={submit}>
        <div className="field">
          <label className="label">Пароль</label>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label className="label">Ещё раз</label>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 6 }}>
          {busy ? "…" : "Сохранить пароль"}
        </button>
      </form>
    </Shell>
  );
}
