# Конфигурация

Файл `.env` в корне читает локальный control plane. На Fly те же имена заданы секретами или `[env]` в `fly.toml`. Образец без значений — `.env.example`.

`SECRETS_KEY` и `AUTH_SECRET` генерируются так:

```bash
openssl rand -base64 32
```

`SECRETS_KEY` после выпуска менять нельзя без перешифровки колонок: это ключ AES-256-GCM, ровно 32 байта после base64.

## Control plane

| Переменная | Обязательна | |
| --- | --- | --- |
| `DATABASE_URL` | да, на первом запросе | PostgreSQL. На Fly приходит из `fly mpg attach`. |
| `AUTH_SECRET` | да | Сессии better-auth. |
| `APP_URL` | нет | Публичный адрес. Локально `http://localhost:3000`. От него собираются redirect Google и `CONTROL_PLANE_URL` на машине агента. |
| `SECRETS_KEY` | да, когда пишутся секреты | 32 байта, base64. |
| `AGENTS_DOMAIN` | да, при создании агента | Receiving-домен. У тенанта может быть свой, колонка `agents_domain`. |
| `OPENROUTER_API_KEY` | да, при создании агента | Принимается и имя `OPEN_ROUTER_API_KEY`. |
| `FLY_API_TOKEN` | да, чтобы поднять машину | Токен организации: создание приложений, не deploy-токен одного приложения. |
| `FLY_ORG` | нет | По умолчанию `personal`. На текущем деплое — `anton-seidler`. |
| `FLY_REGION` | нет | По умолчанию `ams`. |
| `AGENT_RUNTIME_IMAGE` | нет | По умолчанию `registry.fly.io/swarm-agent-runtime:latest`. |
| `HERMES_IMAGE` | нет | По умолчанию `nousresearch/hermes-agent:latest`. |
| `MAILGUN_API_KEY` | для отправки | Письма агентов и сброс пароля (с `no-reply@AGENTS_DOMAIN`). |
| `MAILGUN_SIGNING_KEY` | см. [почту](mail.md) | Пусто вместе с токеном — вебхук открыт и пишет предупреждение. |
| `MAILGUN_REGION` | нет | `eu` или `us`. По умолчанию `eu`. |
| `WEBHOOK_URL` | для `pnpm mailgun route` | Куда Mailgun шлёт письма. Обычно `{APP_URL}/webhooks/email`. |
| `INBOUND_WEBHOOK_TOKEN` | для JSON-входа | |
| `SKYVERN_API_KEY` | нет | Без него MCP Skyvern в конфиг Hermes не добавляется. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | пара | Без пары браузер в runtime отвечает ошибкой на открытие сессии. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | пара | Без них кнопка Google возвращает на карточку с ошибкой. |
| `DEV_RUNTIME_URL` | нет | Локальный runtime вместо `*.flycast`. |
| `SKILL_TEMPLATE_DIR` | в контейнере | Каталог с `swarm-worker/SKILL.md`. В образе это `/app/agent-template`. |

## Runtime

Их задаёт control plane, когда собирает машину. Локально их нужно выставить самому, см. [локальный запуск](local.md).

| Переменная | |
| --- | --- |
| `AGENT_ID`, `AGENT_EMAIL`, `RUNTIME_TOKEN` | Обязательны. |
| `AGENT_NAME`, `AGENT_MODEL`, `AGENT_AUTONOMOUS` | Имя, модель, `true`/`false`. |
| `OWNER_EMAIL` | Куда слать вопрос одобрения. |
| `OPENROUTER_API_KEY` | Обязателен. |
| `CONTROL_PLANE_URL` | Куда runtime сдаёт письма и рецепты. |
| `DATA_DIR` | Каталог состояния. В машине `/opt/data`, локально любой. |
| `PORT` | По умолчанию 8787. |
| `HERMES_API_URL` | По умолчанию `http://127.0.0.1:8642/v1`. |
| `HERMES_API_KEY` | Если пусто, берётся `API_SERVER_KEY`. На машине это runtime-токен. |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | |
| `SKYVERN_API_KEY` | |
| `TICK_MINUTES` | По умолчанию 15. |
| `IDLE_SUSPEND` | `off` — не засыпать. Иначе засыпает, когда задан `CONTROL_PLANE_URL`. |
| `IDLE_SUSPEND_MS` | Пауза перед сном. По умолчанию 120000. |
| `BOOTSTRAP_DIR` | Если задан, при старте файлы оттуда копируются в `DATA_DIR`. |

Ключ Mailgun на машину агента не попадает. Отправка идёт через control plane.
