import type { TenantUsage } from "@/lib/usage-totals";
import { usageCaveat } from "@/lib/usage-totals";
import { formatNumber, t } from "@/i18n";
import { usd } from "./agent-dashboard/format";
import { Skeleton } from "./skeleton";

/** Деньги и токены по всем агентам тенанта. Подробности по задачам — на карточке агента. */
export function UsageStats({ usage }: { usage: TenantUsage }) {
  const caveat = usageCaveat(usage.agents);
  return (
    <section aria-label={t("usage.aria")}>
      <div className="stats">
        <div className="stat-card">
          <span className="stat-value">{usd(usage.totalCostUsd)}</span>
          <span className="stat-label">{t("usage.tenantSpent")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{formatNumber(usage.totalPromptTokens)}</span>
          <span className="stat-label">{t("usage.prompt")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{formatNumber(usage.totalCompletionTokens)}</span>
          <span className="stat-label">{t("usage.completion")}</span>
        </div>
      </div>
      {caveat && (
        <p className="faint small" style={{ margin: "-6px 0 16px" }}>
          {caveat}
        </p>
      )}
    </section>
  );
}

export function UsageStatsSkeleton() {
  return (
    <div className="stats" aria-busy="true">
      {[t("usage.tenantSpent"), t("usage.prompt"), t("usage.completion")].map((label) => (
        <div key={label} className="stat-card">
          <Skeleton width={96} height={36} />
          <span className="stat-label">{label}</span>
        </div>
      ))}
    </div>
  );
}
