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
| `FLY_API_TOKEN` | да, чтобы поднять машину | Токен организации: один раз создаёт приложение агентов. Deploy-токен control plane этого не умеет. |
| `FLY_ORG` | нет | По умолчанию `personal`. На текущем деплое — `copyboy`. |
| `FLY_REGION` | нет | По умолчанию `ams`. |
| `FLY_AGENTS_APP` | нет | Приложение, в котором живут машины агентов. По умолчанию `swarm-agents`. После создания агентов не переименовывать: машина остаётся в том приложении, которое записано в строке. |
| `RELEASE` | ставит CI | SHA коммита, из которого собран образ. Задаёт образ runtime по умолчанию и порог, до которого control plane дотягивает машины агентов (см. [деплой](deploy.md)). Пусто — обновление агентов выключено. |
| `AGENT_RUNTIME_IMAGE` | нет | По умолчанию `registry.fly.io/swarm-agent-runtime:<RELEASE>`, без `RELEASE` — `:latest`. |
| `HERMES_IMAGE` | нет | По умолчанию `nousresearch/hermes-agent:latest`. |
| `MAILGUN_API_KEY` | для отправки | Письма агентов и сброс пароля (с `no-reply@AGENTS_DOMAIN`). |
| `MAILGUN_SIGNING_KEY` | см. [почту](mail.md) | Пусто вместе с токеном — вебхук открыт и пишет предупреждение. |
| `MAILGUN_REGION` | нет | `eu` или `us`. По умолчанию `eu`. |
| `WEBHOOK_URL` | для `pnpm mailgun route` | Куда Mailgun шлёт письма. Обычно `{APP_URL}/webhooks/email`. |
| `INBOUND_WEBHOOK_TOKEN` | для JSON-входа | |
| `SKYVERN_API_KEY` | для онбординга | Регистрация по приглашению и обход капчи идут через Skyvern; коды из писем runtime передаёт ему сам. Без него и если Skyvern не довёл вход, приглашение принимает свой Chromium. Без ключа MCP Skyvern в конфиг Hermes не добавляется. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | пара | Без них кнопка Google возвращает на карточку с ошибкой. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | пара | Нужны, чтобы обмен кода на `{APP_URL}/api/slack/callback` сохранил user token и bot token. Отдельной кнопки установки приложения нет: агента приглашают в Slack по почте. У бота в приложении Slack — `chat:write` и `chat:write.public`. |
| `SLACK_SIGNING_SECRET` | для событий | Без него `POST /webhooks/slack` и `POST /webhooks/slack/interactions` отвечают 503. Signing Secret приложения Slack. События на пользователя: `message.im`, `message.channels`, `message.groups`, `message.mpim`. Interactivity Request URL — `{APP_URL}/webhooks/slack/interactions`. |
| `DEV_RUNTIME_URL` | нет | Локальный runtime вместо `*.flycast`. |
| `SKILL_TEMPLATE_DIR` | в контейнере | Каталог с `swarm-worker/SKILL.md`. В образе это `/app/agent-template`. |

## Runtime

Их задаёт control plane, когда собирает машину. Локально их нужно выставить самому, см. [локальный запуск](local.md).

| Переменная | |
| --- | --- |
| `AGENT_ID`, `AGENT_EMAIL`, `RUNTIME_TOKEN` | Обязательны. |
| `AGENT_NAME`, `AGENT_MODEL`, `AGENT_AUTONOMOUS` | Отображаемое имя («Имя Фамилия»), модель, `true`/`false`. |
| `AGENT_FIRST_NAME`, `AGENT_LAST_NAME` | Имя и фамилия для форм регистрации. Пусто — runtime режет `AGENT_NAME` по первому пробелу. |
| `AGENT_FALLBACK_MODEL` | Запасная модель для разбора писем и чата, когда основная перегружена (429) или отвечает пусто. По умолчанию `openai/gpt-4.1-mini`. |
| `OWNER_EMAIL` | Куда слать вопрос одобрения. |
| `OPENROUTER_API_KEY` | Обязателен. |
| `CONTROL_PLANE_URL` | Куда runtime сдаёт письма и рецепты. |
| `DATA_DIR` | Каталог состояния. В машине `/opt/data`, локально любой. |
| `PORT` | По умолчанию 8787. |
| `HERMES_API_URL` | По умолчанию `http://127.0.0.1:8642/v1`. |
| `HERMES_API_KEY` | Если пусто, берётся `API_SERVER_KEY`. На машине это runtime-токен. |
| `SKYVERN_API_KEY` | |
| `CHROME_PATH` | Путь к Chromium. В образе агента это `/usr/bin/chromium`. |
| `TICK_MINUTES` | По умолчанию 15. |
| `IDLE_SUSPEND` | `off` — не засыпать. Иначе засыпает, когда задан `CONTROL_PLANE_URL`. |
| `IDLE_SUSPEND_MS` | Пауза перед сном. По умолчанию 120000. |
| `BOOTSTRAP_DIR` | Если задан, при старте файлы оттуда копируются в `DATA_DIR`. |

Ключ Mailgun на машину агента не попадает. Отправка идёт через control plane.
