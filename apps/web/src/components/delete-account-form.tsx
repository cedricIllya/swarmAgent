"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { useConfirm } from "@/components/confirm-dialog";

export function DeleteAccountForm({ email, agentsTotal }: { email: string; agentsTotal: number }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const ok = await confirm({
      title: "Удалить аккаунт навсегда?",
      body:
        agentsTotal > 0
          ? `Аккаунт ${email} исчезнет вместе с ${agentsTotal} агентами: машины, диски и история будут уничтожены.`
          : `Аккаунт ${email} и все связанные данные будут удалены.`,
      confirmLabel: "Удалить аккаунт",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    const res = await authClient.deleteUser();
    if (res.error) {
      setBusy(false);
      setError(res.error.message ?? "Не получилось удалить аккаунт");
      return;
    }
    router.push("/login?deleted=1");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="delete-account-form">
      {error && <p className="error">{error}</p>}
      <button className="btn btn-danger" type="submit" disabled={busy}>
        {busy ? "Удаляем…" : "Удалить аккаунт навсегда"}
      </button>
      {busy && agentsTotal > 0 && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Сносим машины агентов, это может занять до минуты.
        </p>
      )}
    </form>
  );
}
