# Swarm Agent

Сервис, где у каждого пользователя несколько AI-агентов. У агента свой почтовый адрес на общем
домене Mailgun и своя всегда включённая машина на Fly.io с [Hermes Agent](https://github.com/NousResearch/hermes-agent).
На адрес присылают приглашение в сервис — агент входит по лестнице **MCP → API → браузер**,
онбордится и дальше раз в 15 минут проверяет задачи в подключённых сервисах. Модели — любые из OpenRouter.

## Структура

```
apps/web             Next.js: вход/регистрация, список агентов, карточка агента, API, вебхук почты
apps/agent-runtime   процесс на машине агента: почта, чат, одобрения, Stagehand/Skyvern, журнал денег
packages/contracts   zod-схемы: письмо, рецепты сервисов, агент, usage, HTTP control plane ↔ runtime
packages/db          PostgreSQL + Drizzle: тенанты, пользователи, членство, агенты, каталог, секреты
packages/crypto      AES-256-GCM для секретов тенантов
packages/identity    better-auth и тенанты
packages/agents      реестр агентов
packages/mail        адрес из имени, подпись Mailgun, нормализация form/JSON, отправка
packages/fly         Machines API: приложение, volume, машина с двумя контейнерами
packages/connections общий каталог способов входа + секреты тенанта → services.json
packages/google      OAuth и google_token.json
packages/usage       разбор usage OpenRouter и суммы по задачам/действиям
packages/hermes-config config.yaml, .env, cron, скилл
agent-template/      SKILL.md рабочего агента
scripts/mailgun.ts   домен, DNS, Route → вебхук
fly.toml             control plane
```

Границы: `apps/agent-runtime` импортирует только `contracts` и `usage`. Пакеты не импортируют друг
друга, кроме `contracts`, `db` и `crypto`.

## Запуск

```bash
pnpm install
cp .env.example .env         # заполнить
pnpm db:generate && pnpm db:migrate
pnpm dev                     # http://localhost:3000
```

Нужен PostgreSQL (`DATABASE_URL`). `SECRETS_KEY` — 32 байта в base64: `openssl rand -base64 32`.

### Почта

```bash
pnpm mailgun status    # что есть, DNS-записи (ничего не меняет)
pnpm mailgun domain    # создать receiving-домен (spam_action=tag)
pnpm mailgun verify    # перепроверить DNS
pnpm mailgun route     # match_recipient(".*@домен") → forward(WEBHOOK_URL) → stop()
```

MX `mxa.mailgun.org` / `mxb.mailgun.org`, SPF и DKIM ставятся у регистратора вручную.
Вебхук `POST /webhooks/email` принимает form-urlencoded (Mailgun, HMAC-подпись, окно 5 минут)
и JSON (Postmark, `INBOUND_WEBHOOK_TOKEN`). Без ключей — принимает и громко пишет в лог.

### Машина агента

Образ runtime: `docker build -f apps/agent-runtime/Dockerfile -t registry.fly.io/swarm-agent-runtime:latest .`
и `fly deploy`/`docker push`. Образ Hermes — `nousresearch/hermes-agent:latest`.
Control plane создаёт для агента приложение `swarm-<id>`, volume 10 GB на `/opt/data` и одну
Machine с двумя контейнерами. Hermes стартует после того, как runtime стал healthy и разложил
`config.yaml`, `.env`, `cron/jobs.json`, `skills/swarm-worker/SKILL.md`, `services.json`.

Локально runtime можно поднять без Fly:

```bash
AGENT_ID=agt_dev AGENT_EMAIL=dev@agents.test RUNTIME_TOKEN=dev OPENROUTER_API_KEY=... DATA_DIR=/tmp/swarm pnpm dev:runtime
# и в .env control plane: DEV_RUNTIME_URL=http://localhost:8787
```

### Проверка

```bash
pnpm typecheck
pnpm test
```
