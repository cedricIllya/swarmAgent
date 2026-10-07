"use client";

import { useState, type FormEvent } from "react";
import type { Agent } from "@swarm/contracts";
import { t } from "@/i18n";
import { ModelSelect } from "./model-select";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

export function CreateAgentForm({ ownerLogin, onCreated }: { ownerLogin: string; onCreated: (a: Agent) => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <form onSubmit={submit}>
      <h2 style={{ marginBottom: 14 }}>{t("createAgent.title")}</h2>
      <div className="name-fields">
        <div className="field">
          <label className="label">{t("createAgent.firstName")}</label>
          <input
            className="input"
            required
            maxLength={40}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder={t("createAgent.firstPlaceholder")}
            autoComplete="given-name"
          />
        </div>
        <div className="field">
          <label className="label">{t("createAgent.lastName")}</label>
          <input
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
        <label className="label">{t("createAgent.model")}</label>
        <ModelSelect value={model} onChange={setModel} disabled={busy} />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !firstName.trim() || !lastName.trim()}>
          {busy ? t("createAgent.creating") : t("createAgent.create")}
        </button>
      </div>
    </form>
  );
}
