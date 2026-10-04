"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";

export function AuthForm({ mode, notice = null }: { mode: "login" | "register"; notice?: string | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "login"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0] || "User" });
    setBusy(false);
    if (res.error) {
      setError(res.error.message ?? "Не получилось");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand-mark" aria-hidden />
          Swarm
        </div>
        <h1 style={{ marginBottom: 6 }}>{mode === "login" ? "Вход" : "Регистрация"}</h1>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 18 }}>
          {mode === "login" ? "С возвращением." : "Личное пространство создастся автоматически."}
        </p>
        {notice && (
          <div className="notice" style={{ marginBottom: 16 }}>
            {notice}
          </div>
        )}
        {mode === "register" && (
          <div className="field">
            <label className="label">Имя</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Как к вам обращаться" />
          </div>
        )}
        <div className="field">
          <label className="label">Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div className="field">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label className="label">Пароль</label>
            {mode === "login" && (
              <Link className="small" href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : "/forgot-password"}>
                Забыли пароль?
              </Link>
            )}
          </div>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 6 }}>
          {busy ? "…" : mode === "login" ? "Войти" : "Создать аккаунт"}
        </button>
        <p className="muted small" style={{ textAlign: "center", marginTop: 14, marginBottom: 0 }}>
          {mode === "login" ? (
            <>
              Нет аккаунта? <Link href="/register">Зарегистрироваться</Link>
            </>
          ) : (
            <>
              Уже есть аккаунт? <Link href="/login">Войти</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
