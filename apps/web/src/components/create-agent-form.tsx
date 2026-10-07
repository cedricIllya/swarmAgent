"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Agent } from "@swarm/contracts";
import { t } from "@/i18n";
import { ModelSelect } from "./model-select";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function CreateAgentDialog({
  ownerLogin,
  onClose,
  onCreated,
}: {
  ownerLogin: string;
  onClose: () => void;
  onCreated: (a: Agent) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function requestClose() {
    if (!busy) onClose();
  }

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim(), model }),
    });
    const json = (await res.json()) as { agent?: Agent; error?: string };
    setBusy(false);
    if (!res.ok || !json.agent) {
      setError(json.error ?? t("common.failed"));
      return;
    }
    onCreated(json.agent);
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal modal-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <form onSubmit={submit}>
          <h2 id={titleId} style={{ marginBottom: 14 }}>
            {t("createAgent.title")}
          </h2>
          <div className="name-fields">
            <div className="field">
              <label className="label" htmlFor="agent-first-name">
                {t("createAgent.firstName")}
              </label>
              <input
                id="agent-first-name"
                className="input"
                required
                maxLength={40}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t("createAgent.firstPlaceholder")}
                autoComplete="given-name"
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="agent-last-name">
                {t("createAgent.lastName")}
              </label>
              <input
                id="agent-last-name"
                className="input"
                required
                maxLength={40}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t("createAgent.lastPlaceholder")}
                autoComplete="family-name"
              />
            </div>
          </div>
          <p className="faint small" style={{ margin: "-6px 0 14px" }}>
            {t("createAgent.addressHint", { login: ownerLogin })}
          </p>
          <div className="field">
            <label className="label" htmlFor="agent-model">
              {t("createAgent.model")}
            </label>
            <ModelSelect id="agent-model" value={model} onChange={setModel} disabled={busy} />
          </div>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy || !firstName.trim() || !lastName.trim()}>
              {busy ? t("createAgent.creating") : t("createAgent.create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
