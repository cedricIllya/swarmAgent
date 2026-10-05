import type { Viewer } from "@/lib/session";
import type { DeletionPreview } from "@/lib/delete-account";
import { DeleteAccountForm } from "./delete-account-form";

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function AccountSettings({ viewer, preview }: { viewer: Viewer; preview: DeletionPreview }) {
  const agentsTotal = preview.tenants.reduce((n, t) => n + t.agents, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="kicker">Аккаунт</span>
          <h1>Настройки</h1>
          <p className="lead">Кто вы в системе и что с этим можно сделать.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Профиль</h2>
            <span className="muted small">Данные, под которыми вы входите</span>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Имя</dt>
            <dd>{viewer.user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd className="mono">{viewer.user.email}</dd>
          </div>
          <div>
            <dt>Пространство</dt>
            <dd>{viewer.tenant.name}</dd>
          </div>
        </dl>
      </section>

      <section className="card card-danger">
        <div className="card-head">
          <div>
            <h2>Удалить аккаунт</h2>
            <span className="muted small">Необратимо. Восстановить ничего не получится.</span>
          </div>
        </div>

        <p className="muted small" style={{ marginTop: 0 }}>
          Вместе с аккаунтом исчезнут:
        </p>
        <ul className="muted small deletion-list">
          {preview.tenants.map((t) => (
            <li key={t.id}>
              пространство <strong>{t.name}</strong>
              {t.agents > 0 ? (
                <>
                  {" "}
                  и {plural(t.agents, "агент", "агента", "агентов")} в нём — машины, диски, история чатов и все сохранённые
                  входы в сервисы
                </>
              ) : (
                " (агентов нет)"
              )}
            </li>
          ))}
          <li>ваш вход, пароль и активные сессии</li>
        </ul>
        {preview.sharedTenants.length > 0 && (
          <p className="muted small">
            Из общих пространств ({preview.sharedTenants.map((t) => t.name).join(", ")}) вы просто выйдете — они останутся
            другим участникам.
          </p>
        )}

        <DeleteAccountForm email={viewer.user.email} agentsTotal={agentsTotal} />
      </section>
    </>
  );
}
