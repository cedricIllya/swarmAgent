# Локальный запуск

Нужны Node 24 и pnpm 12. В репозитории пакетный менеджер зафиксирован как `pnpm@12.8.1`.

```bash
pnpm install
cp .env.example .env
```

Поднять PostgreSQL и записать `DATABASE_URL`. Сгенерировать `AUTH_SECRET` и `SECRETS_KEY` (`openssl rand -base64 32`). Для списка моделей и ответов агента нужен `OPENROUTER_API_KEY`.

```bash
pnpm db:migrate
pnpm dev
```

Control plane: http://localhost:3000. Регистрация создаёт тенант. Создание агента без `FLY_API_TOKEN` сохранится в базе и сразу станет `failed` с текстом, чего не хватает.

`pnpm db:generate` нужен только после правки `packages/db/src/schema.ts`.

## Runtime без Fly

В другом терминале:

```bash
AGENT_ID=agt_dev \
AGENT_NAME=Dev \
AGENT_EMAIL=dev@agents.test \
OWNER_EMAIL=you@example.com \
RUNTIME_TOKEN=dev \
OPENROUTER_API_KEY=sk-or-... \
AGENT_MODEL=openai/gpt-4.1-mini \
DATA_DIR=/tmp/swarm \
pnpm dev:runtime
```

В `.env` control plane:

```
DEV_RUNTIME_URL=http://localhost:8787
```

Тогда карточка и вебхук ходят на этот процесс, даже если в базе у агента ещё нет `runtime_url`. `RUNTIME_TOKEN` в команде и расшифрованный токен агента в базе должны совпасть, иначе runtime ответит 401. Для чисто локальной проверки токен можно выставить одинаковым и не поднимать Fly.

Почта в эту схему попадает так: Mailgun (или `curl`) бьёт в локальный `POST /webhooks/email`. Без signing key и без `INBOUND_WEBHOOK_TOKEN` вебхук письмо примет и напишет в лог, что проверка выключена.

Проверка подписи и разбора письма без сервера:

```bash
pnpm test
pnpm typecheck
```

Тесты покрывают адрес, подпись Mailgun, нормализацию письма, слова «да/нет», шифрование и суммы usage.
