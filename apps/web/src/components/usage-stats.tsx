import type { TenantUsage } from "@/lib/usage-totals";
import { usageCaveat } from "@/lib/usage-totals";
import { usd } from "./agent-dashboard/format";
import { Skeleton } from "./skeleton";

export const USAGE_STAT_LABELS = ["потрачено всеми агентами", "токенов на вход", "токенов на выход"] as const;

/** Деньги и токены по всем агентам тенанта. Подробности по задачам — на карточке агента. */
export function UsageStats({ usage }: { usage: TenantUsage }) {
  const caveat = usageCaveat(usage.agents);
  return (
    <section aria-label="Расходы агентов">
      <div className="stats">
        <div className="stat-card">
          <span className="stat-value">{usd(usage.totalCostUsd)}</span>
          <span className="stat-label">{USAGE_STAT_LABELS[0]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{usage.totalPromptTokens.toLocaleString("ru-RU")}</span>
          <span className="stat-label">{USAGE_STAT_LABELS[1]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{usage.totalCompletionTokens.toLocaleString("ru-RU")}</span>
          <span className="stat-label">{USAGE_STAT_LABELS[2]}</span>
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
      {USAGE_STAT_LABELS.map((label) => (
        <div key={label} className="stat-card">
          <Skeleton width={96} height={36} />
          <span className="stat-label">{label}</span>
        </div>
      ))}
    </div>
  );
}
