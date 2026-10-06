"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConfirm } from "./confirm-dialog";

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ServiceAgentChips({
  slug,
  serviceName,
  agents,
}: {
  slug: string;
  serviceName: string;
  agents: Array<{
    agentId: string;
    agentName: string;
    agentEmail: string;
    accountEmail: string | null;
    updatedAt: string;
  }>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="chips">
      {agents.map((agent) => (
        <span key={agent.agentId} className="chip">
          <Link
            href={`/agents/${agent.agentId}`}
            title={`${agent.agentEmail}${agent.accountEmail ? ` · ${agent.accountEmail}` : ""} · ${fmtDate(agent.updatedAt)}`}
          >
            <span className="chip-dot" />
            {agent.agentName}
            {agent.accountEmail && <span className="chip-meta">{agent.accountEmail}</span>}
          </Link>
          <DisconnectServiceButton
            agentId={agent.agentId}
            slug={slug}
            serviceName={serviceName}
            agentName={agent.agentName}
            variant="chip"
            onFailed={setError}
          />
        </span>
      ))}
      {error && (
        <span className="faint small" style={{ flexBasis: "100%", textAlign: "right" }}>
          {error}
        </span>
      )}
    </div>
  );
}

export function DisconnectServiceButton({
  agentId,
  slug,
  serviceName,
  agentName,
  variant = "button",
  onRemoved,
  onFailed,
}: {
  agentId: string;
  slug: string;
  serviceName: string;
  agentName?: string;
  variant?: "button" | "chip";
  onRemoved?: () => void;
  onFailed?: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (busy) return;
    const where = agentName ? ` у агента ${agentName}` : "";
    const ok = await confirm({
      title: `Отключить ${serviceName}${where}?`,
      body: "Агент потеряет вход в этот сервис. Ключ, пароль и сессия браузера будут удалены.",
      confirmLabel: "Отключить",
    });
    if (!ok) return;
    setBusy(true);
    onFailed?.(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/credentials/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        onFailed?.(body?.error ?? "Не получилось отключить сервис");
        return;
      }
      onRemoved?.();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const label = variant === "chip" ? "×" : busy ? "Отключаем…" : "Отключить";
  return (
    <button
      type="button"
      className={variant === "chip" ? "chip-remove" : "btn btn-sm btn-ghost"}
      aria-label={`Отключить ${serviceName}${agentName ? ` у ${agentName}` : ""}`}
      disabled={busy}
      onClick={() => void remove()}
    >
      {label}
    </button>
  );
}

export function DisconnectGoogleButton({
  agentId,
  agentName,
  onRemoved,
  onFailed,
}: {
  agentId: string;
  agentName?: string;
  onRemoved?: () => void;
  onFailed?: (message: string | null) => void;
}) {
  const confirm = useConfirm();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (busy) return;
    const where = agentName ? ` у агента ${agentName}` : "";
    const ok = await confirm({
      title: `Отключить Google${where}?`,
      body: "Доступ к почте, календарю и документам будет отозван. Чтобы вернуть его, потребуется снова войти в Google.",
      confirmLabel: "Отключить",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    onFailed?.(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/google`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = body?.error ?? "Не получилось отключить Google";
        setError(message);
        onFailed?.(message);
        return;
      }
      onRemoved?.();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void remove()}>
        {busy ? "Отключаем…" : "Отключить"}
      </button>
      {error && !onFailed && <span className="faint small">{error}</span>}
    </>
  );
}
