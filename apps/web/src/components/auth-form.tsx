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
  const [passwordAgain, setPasswordAgain] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = mode === "register" && passwordAgain.length > 0 && password !== passwordAgain;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== passwordAgain) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
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
          {mode === "register" ? (
            <PasswordField
              value={password}
              onChange={setPassword}
              revealed={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              autoComplete="new-password"
              minLength={8}
            />
          ) : (
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          )}
        </div>
        {mode === "register" && (
          <div className="field">
            <label className="label">Пароль ещё раз</label>
            <PasswordField
              value={passwordAgain}
              onChange={setPasswordAgain}
              revealed={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              autoComplete="new-password"
              minLength={8}
            />
            {mismatch && <p className="error">Пароли не совпадают</p>}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy || mismatch} style={{ width: "100%", marginTop: 6 }}>
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

/** Поле пароля с кнопкой показа. Оба поля регистрации делят одно состояние видимости. */
function PasswordField({
  value,
  onChange,
  revealed,
  onToggle,
  autoComplete,
  minLength,
}: {
  value: string;
  onChange: (value: string) => void;
  revealed: boolean;
  onToggle: () => void;
  autoComplete: string;
  minLength: number;
}) {
  return (
    <div className="password-field">
      <input
        className="input"
        type={revealed ? "text" : "password"}
        required
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
      <button type="button" className="password-toggle" onClick={onToggle} aria-label={revealed ? "Скрыть пароль" : "Показать пароль"}>
        <EyeIcon off={revealed} />
      </button>
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 10.6a2 2 0 002.8 2.8" />
          <path d="M9.9 5.1A10.7 10.7 0 0112 5c5 0 9.3 3.1 11 7a11.8 11.8 0 01-4.2 5.1M6.1 6.1A11.8 11.8 0 001 12c1.7 3.9 6 7 11 7 1.6 0 3.1-.3 4.5-.9" />
        </>
      ) : (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}
