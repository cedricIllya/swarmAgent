"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { count, t } from "@/i18n";
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
      title: t("settings.deleteTitle"),
      body:
        agentsTotal > 0
          ? t("settings.deleteWithAgents", { email, agents: count(agentsTotal, "agents") })
          : t("settings.deleteOnly", { email }),
      confirmLabel: t("settings.deleteConfirm"),
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    const res = await authClient.deleteUser();
    if (res.error) {
      setBusy(false);
      setError(res.error.message ?? t("settings.deleteFailed"));
      return;
    }
    router.push("/login?deleted=1");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="delete-account-form">
      {error && <p className="error">{error}</p>}
      <button className="btn btn-danger" type="submit" disabled={busy}>
        {busy ? t("common.deleting") : t("settings.deleteButton")}
      </button>
      {busy && agentsTotal > 0 && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {t("settings.deletingMachines")}
        </p>
      )}
    </form>
  );
}
