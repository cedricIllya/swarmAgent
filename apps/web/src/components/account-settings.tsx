import type { Viewer } from "@/lib/session";
import type { DeletionPreview } from "@/lib/delete-account";
import { count, t } from "@/i18n";
import { DeleteAccountForm } from "./delete-account-form";
import { ThemePreference } from "./theme-toggle";

export function AccountSettings({ viewer, preview }: { viewer: Viewer; preview: DeletionPreview }) {
  const agentsTotal = preview.tenants.reduce((n, t) => n + t.agents, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="kicker">{t("settings.kicker")}</span>
          <h1>{t("settings.title")}</h1>
          <p className="lead">{t("settings.lead")}</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>{t("settings.profile")}</h2>
            <span className="muted small">{t("settings.profileLead")}</span>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>{t("common.name")}</dt>
            <dd>{viewer.user.name}</dd>
          </div>
          <div>
            <dt>{t("common.email")}</dt>
            <dd className="mono">{viewer.user.email}</dd>
          </div>
          <div>
            <dt>{t("settings.space")}</dt>
            <dd>{viewer.tenant.name}</dd>
          </div>
        </dl>
      </section>

      <ThemePreference />

      <section className="card card-danger">
        <div className="card-head">
          <div>
            <h2>{t("settings.dangerTitle")}</h2>
            <span className="muted small">{t("settings.dangerLead")}</span>
          </div>
        </div>

        <p className="muted small" style={{ marginTop: 0 }}>
          {t("settings.dangerGone")}
        </p>
        <ul className="muted small deletion-list">
          {preview.tenants.map((tenant) => (
            <li key={tenant.id}>
              {t("settings.spaceNamed")} <strong>{tenant.name}</strong>
              {tenant.agents > 0 ? (
                <>
                  {" "}
                  {t("settings.agentsInIt", { agents: count(tenant.agents, "agents") })}
                </>
              ) : (
                ` ${t("settings.noAgents")}`
              )}
            </li>
          ))}
          <li>{t("settings.credentials")}</li>
        </ul>
        {preview.sharedTenants.length > 0 && (
          <p className="muted small">
            {t("settings.sharedLeave", { names: preview.sharedTenants.map((tenant) => tenant.name).join(", ") })}
          </p>
        )}

        <DeleteAccountForm email={viewer.user.email} agentsTotal={agentsTotal} />
      </section>
    </>
  );
}
