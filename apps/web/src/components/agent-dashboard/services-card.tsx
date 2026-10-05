"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Agent, RuntimeState } from "@swarm/contracts";
import { ListSkeleton } from "../skeleton";

interface SavedLogin {
  slug: string;
  name: string;
  kind: "mcp" | "api" | "browser";
  accountEmail: string | null;
  accountName: string | null;
  password: string | null;
}

const KIND_LABEL = { mcp: "MCP", api: "API", browser: "браузер" } as const;

/** Сервисы, куда агент вошёл: живой список из runtime плюс сохранённые аккаунты и пароли. */
export function ServicesCard({ agent, state, pending }: { agent: Agent; state: RuntimeState | null; pending: boolean }) {
  const [logins, setLogins] = useState<SavedLogin[]>([]);
  const [loginsReady, setLoginsReady] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const live = state?.connectedServices ?? [];

  useEffect(() => {
    let cancel = false;
    void fetch(`/api/agents/${agent.id}/credentials`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || cancel) return;
        setLogins((await res.json()) as SavedLogin[]);
      })
      .finally(() => {
        if (!cancel) setLoginsReady(true);
      });
    return () => {
      cancel = true;
    };
  }, [agent.id, live.length]);

  const rows = new Map<string, SavedLogin>();
  for (const s of live) {
    const saved = logins.find((l) => l.slug === s.slug);
    rows.set(s.slug, {
      slug: s.slug,
      name: s.name,
      kind: s.kind,
      accountEmail: saved?.accountEmail ?? s.accountEmail ?? null,
      accountName: saved?.accountName ?? s.accountName ?? null,
      password: saved?.password ?? null,
    });
  }
  for (const saved of logins) if (!rows.has(saved.slug)) rows.set(saved.slug, saved);
  const list = [...rows.values()];

  return (
    <section className="card" aria-busy={pending || !loginsReady}>
      <div className="card-head">
        <div>
          <h2>Подключённые сервисы</h2>
          <span className="muted small">Куда агент вошёл и под каким аккаунтом</span>
        </div>
        <Link href="/services" className="small">
          Все сервисы →
        </Link>
      </div>
      {pending || !loginsReady ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          Пока ничего. Пришлите приглашение на <code>{agent.email}</code> или вставьте ссылку и ключ в чат.
        </p>
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.slug} className="list-item">
              <div>
                <div>{s.name}</div>
                <div className="faint small mono">{s.slug}</div>
                {(s.accountName || s.accountEmail) && (
                  <div className="small" style={{ marginTop: 4 }}>
                    {[s.accountName, s.accountEmail].filter(Boolean).join(" · ")}
                  </div>
                )}
                {s.password && (
                  <button
                    type="button"
                    className="linkish small"
                    style={{ marginTop: 4 }}
                    onClick={() => setShown((prev) => ({ ...prev, [s.slug]: !prev[s.slug] }))}
                  >
                    {shown[s.slug] ? s.password : "Показать пароль"}
                  </button>
                )}
              </div>
              <span className="badge">{KIND_LABEL[s.kind]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
