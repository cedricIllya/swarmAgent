import type { CSSProperties } from "react";

export function Skeleton({
  width,
  height,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={className ? `skeleton ${className}` : "skeleton"} style={{ width, height, ...style }} aria-hidden />;
}

/** Шапка страницы: те же вертикальные шаги, что у kicker + h1 + lead. */
export function PageHeadSkeleton({
  kicker,
  title,
  lead,
  action,
  detail,
}: {
  kicker: number;
  title: number;
  lead?: number;
  action?: number;
  /** Строка под заголовком как у карточки агента, а не абзац lead. */
  detail?: number;
}) {
  return (
    <div className="page-head">
      <div>
        {/* Кикер — inline-block, его строка выше самого текста. Цифры сняты с живой вёрстки. */}
        <Skeleton width={kicker} height={detail ? 21 : 22} style={{ marginBottom: 6 }} />
        <Skeleton width={title} height={37} />
        {detail ? <Skeleton width={detail} height={20} style={{ marginTop: 4 }} /> : null}
        {lead ? <Skeleton width={lead} height={22} style={{ marginTop: 6 }} /> : null}
      </div>
      {action ? <Skeleton width={action} height={action > 100 ? 41 : 34} className="skeleton-pill" /> : null}
    </div>
  );
}

export function ListSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="list" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="list-item">
          <div style={{ flex: 1, minWidth: 0 }}>
            <Skeleton width={i === 0 ? "62%" : "46%"} height={16} />
            <Skeleton width="32%" height={12} style={{ marginTop: 8 }} />
          </div>
          <Skeleton width={72} height={24} className="skeleton-pill" />
        </div>
      ))}
    </div>
  );
}

export function ChatListSkeleton() {
  return (
    <div className="chat-list" aria-hidden>
      <Skeleton height={34} className="skeleton-pill" />
      <Skeleton height={68} className="skeleton-block" />
      <Skeleton height={68} className="skeleton-block" />
      <Skeleton height={54} className="skeleton-block" />
    </div>
  );
}

export function ChatPaneSkeleton() {
  return (
    <div className="chat" aria-busy="true">
      <span className="sr-only">Загрузка сообщений</span>
      <Skeleton className="skeleton-bubble" width="46%" style={{ marginTop: "auto" }} />
      <Skeleton className="skeleton-bubble skeleton-bubble-end" width="62%" />
      <Skeleton className="skeleton-bubble" width="38%" height={72} />
      <Skeleton className="skeleton-bubble skeleton-bubble-end" width="54%" />
    </div>
  );
}

/** Список, лента и поле ввода — та же сетка, что у открытого чата. */
export function ChatWorkspaceSkeleton() {
  return (
    <div className="chat-layout" aria-busy="true">
      <span className="sr-only">Загрузка чата</span>
      <ChatListSkeleton />
      <div>
        <div className="chat-toolbar">
          <Skeleton width={140} height={18} />
        </div>
        <ChatPaneSkeleton />
        <div className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
          <Skeleton className="skeleton-input" />
          <Skeleton width={118} height={40} className="skeleton-pill" />
        </div>
      </div>
    </div>
  );
}

const USAGE_LABELS = ["всего", "токенов на вход", "токенов на выход"] as const;

export function UsageBodySkeleton() {
  return (
    <>
      <div className="row" style={{ gap: 32, marginBottom: 16 }}>
        {USAGE_LABELS.map((label) => (
          <div className="stat" key={label}>
            <Skeleton width={96} height={36} />
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Задача / действие</th>
            <th className="num">Вызовов</th>
            <th className="num">Вход</th>
            <th className="num">Выход</th>
            <th className="num">Стоимость</th>
          </tr>
        </thead>
        <tbody>
          {[0, 1].map((i) => (
            <tr key={i}>
              <td>
                <Skeleton width={i === 0 ? "72%" : "48%"} height={16} />
              </td>
              <td className="num">
                <Skeleton width={28} height={16} style={{ marginLeft: "auto" }} />
              </td>
              <td className="num">
                <Skeleton width={48} height={16} style={{ marginLeft: "auto" }} />
              </td>
              <td className="num">
                <Skeleton width={40} height={16} style={{ marginLeft: "auto" }} />
              </td>
              <td className="num">
                <Skeleton width={52} height={16} style={{ marginLeft: "auto" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function CardHeadSkeleton({ title, aside }: { title: number; aside?: number }) {
  return (
    <div className="card-head">
      <Skeleton width={title} height={26} />
      {aside ? <Skeleton width={aside} height={14} /> : null}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Загрузка агента</span>
      <PageHeadSkeleton kicker={112} title={220} detail={240} action={84} />

      <section className="card">
        <div className="card-head">
          <Skeleton width={210} height={26} />
          <Skeleton width={280} height={14} />
        </div>
        <div className="email-box">
          <Skeleton width={260} height={18} />
          <Skeleton width={108} height={32} className="skeleton-pill" />
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <Skeleton width={180} height={24} className="skeleton-pill" />
          <Skeleton width={168} height={32} className="skeleton-pill" />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <Skeleton width={64} height={28} />
            <Skeleton width={300} height={20} />
          </div>
          <Skeleton width={280} height={26} className="skeleton-pill" />
        </div>
        <ChatWorkspaceSkeleton />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <Skeleton width={210} height={28} />
            <Skeleton width={260} height={20} />
          </div>
          <Skeleton width={96} height={14} />
        </div>
        <div className="stable-slot">
          <ListSkeleton />
        </div>
      </section>

      <section className="card">
        <CardHeadSkeleton title={130} aside={64} />
        <div className="stable-slot">
          <ListSkeleton />
        </div>
      </section>

      <section className="card">
        <CardHeadSkeleton title={170} aside={240} />
        <div className="stable-slot stable-slot-usage">
          <UsageBodySkeleton />
        </div>
      </section>
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Загрузка</span>
      <PageHeadSkeleton kicker={172} title={118} lead={460} action={156} />
      <div className="grid grid-2">
        {[0, 1].map((i) => (
          <div key={i} className="card">
            <div className="card-head" style={{ marginBottom: 10 }}>
              <Skeleton width={i === 0 ? 132 : 96} height={18} />
              <Skeleton width={76} height={24} className="skeleton-pill" />
            </div>
            <Skeleton width="78%" height={14} />
            <div className="card-foot">
              <Skeleton width={140} height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ServicesSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Загрузка</span>
      <PageHeadSkeleton kicker={172} title={340} lead={520} />
      <div className="stats">
        {["сервисов", "подключений", "агентов с доступом"].map((label) => (
          <div key={label} className="stat-card">
            <Skeleton width={48} height={36} />
            <span className="stat-label">{label}</span>
          </div>
        ))}
      </div>
      <section className="card">
        <div className="card-head">
          <div className="row" style={{ gap: 12 }}>
            <Skeleton width={40} height={40} style={{ borderRadius: 12, flex: "none" }} />
            <div>
              <Skeleton width={180} height={20} />
              <Skeleton width={320} height={14} style={{ marginTop: 6 }} />
            </div>
          </div>
          <Skeleton width={88} height={24} className="skeleton-pill" />
        </div>
        <div className="agent-links">
          {[0, 1].map((i) => (
            <div key={i} className="agent-link">
              <Skeleton width={100} height={16} />
              <Skeleton width={160} height={14} />
              <Skeleton width={120} height={32} className="skeleton-pill" />
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <CardHeadSkeleton title={120} aside={32} />
        <div className="service-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="service-row">
              <Skeleton width={40} height={40} style={{ borderRadius: 12 }} />
              <div className="service-main">
                <Skeleton width={140} height={16} />
                <Skeleton width={180} height={12} style={{ marginTop: 6 }} />
              </div>
              <Skeleton width={96} height={28} className="skeleton-pill" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Загрузка</span>
      <PageHeadSkeleton kicker={72} title={160} lead={360} />
      <section className="card">
        <div className="card-head">
          <div>
            <Skeleton width={80} height={28} />
            <Skeleton width={220} height={20} />
          </div>
        </div>
        <div className="facts">
          {["Имя", "Email", "Пространство"].map((label) => (
            <div key={label}>
              <Skeleton width={88} height={14} />
              <Skeleton width={180} height={16} />
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <div>
            <Skeleton width={160} height={28} />
            <Skeleton width={280} height={20} />
          </div>
        </div>
        <Skeleton width="90%" height={14} />
        <Skeleton width="76%" height={14} style={{ marginTop: 10 }} />
        <Skeleton width="64%" height={14} style={{ marginTop: 10 }} />
        <Skeleton width={180} height={41} className="skeleton-pill" style={{ marginTop: 22 }} />
      </section>
    </div>
  );
}
