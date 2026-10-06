# Данные

Продуктовые данные — в PostgreSQL. Память агента, сессии браузера и журнал денег — на диске его машины; в базе от журнала денег только итоги, чтобы главная считала расходы, не будя машины. Общей векторной базы нет: Hermes учится скиллами и файлом памяти на этом диске.

## PostgreSQL

Клиент и таблицы — `packages/db`. Миграции — `packages/db/drizzle`. Подключение через `postgres` с `prepare: false`, потому что Fly Managed Postgres отдаёт приложение через PgBouncer. Для миграций хост `pgbouncer.` в `DATABASE_URL` подменяется на `direct.`: advisory lock в transaction pooling не держится. Хост `flympg.net` и `sslmode=require` включают TLS.

| Таблица | Что хранит |
| --- | --- |
| `tenants` | Организация. `agents_domain` — свой receiving-домен, если он есть у этого Mailgun. Пусто — берётся `AGENTS_DOMAIN`. |
| `user`, `session`, `account`, `verification` | better-auth. В сессии есть `active_tenant_id`. |
| `memberships` | Кто в каком тенанте и с какой ролью: `owner`, `admin`, `member`. Пара тенант+пользователь уникальна. |
| `agents` | Имя, модель, локальная часть и домен адреса, статус, флаг автономности, id приложения и машины Fly, зашифрованный runtime-токен, зашифрованный Google refresh token. `usage_cost_usd`, `usage_prompt_tokens`, `usage_completion_tokens`, `usage_at` — итоги `usage.jsonl` на момент последнего отчёта машины (перед сном или когда главная читала `/state`); пусто — машина ещё не отчитывалась. Пара `local_part` + `domain` уникальна. |
| `service_recipes` | Способ входа в сервис. Без `tenant_id` и без секретов. Один на весь продукт. `watches_tasks`: есть ли назначенная работа для плановой проверки. |
| `service_credentials` | Секрет агента для рецепта. Принадлежит агенту, который вошёл (`agent_id`), соседи по тенанту его не получают; `tenant_id` — для учёта и каскада. Тело — зашифрованный JSON: токен, cookies, почта, имя и пароль регистрации. Поздний отчёт не затирает уже сохранённый вход. Пара агент+slug уникальна. |

При регистрации пользователю создаётся личный тенант, он становится `owner`.

Секреты в колонках `*_enc` — строка `v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM, ключ `SECRETS_KEY` (32 байта в base64). Сравнение webhook-токена и runtime-токена — побайтовое, чтобы длина и не-ASCII не давали 500.

Идентификаторы: `<префикс>_<20 символов>`, префиксы `usr`, `tnt`, `mem`, `agt`, `crd`.

Статусы агента: `creating`, `provisioning`, `running`, `stopped`, `failed`, `deleting`.

## Диск агента

Volume Fly, 3 GB, смонтирован в `/opt/data` обоим контейнерам. Платится выделенный размер, и во сне тоже. Уже созданный диск меньше не становится. Control plane не монтирует его напрямую: файлы конфигурации кладутся в образ runtime как `/bootstrap`, а процесс при старте копирует их на volume. Писать `files` Machines API прямо в точку монтирования нельзя.

Появляются при создании и переписываются при смене модели:

| Файл | Содержимое |
| --- | --- |
| `config.yaml` | Hermes: OpenRouter, модель, MCP из каталога, Skyvern |
| `.env` | Ключи Hermes, `API_SERVER_*`, `SWARM_RUNTIME_TOKEN` |
| `cron/jobs.json` | Задача раз в 15 минут |
| `skills/swarm-worker/SKILL.md` | Лестница MCP → API → браузер |
| `services.json` | Все рецепты продукта и секреты только этого агента |

Появляются по ходу работы и при перезапуске не затираются:

| Путь | Содержимое |
| --- | --- |
| `runs/<id>/run.json`, `steps.jsonl` | Задача и шаги |
| `chats/<id>/` | Отдельный чат: `chat.json` и `messages.jsonl`. Старый `chat.jsonl` при старте переносится в чат «Общий». |
| `sent.json` | Message-ID писем агента → задача и approval |
| `approvals.json` | Вопросы, на которые ещё нет «да» или «нет» |
| `browser-sessions/<id>/` | `session.json`, `actions.jsonl`, `video.mp4` |
| `browser-profiles/<slug>/` | Профиль Chromium сервиса: cookies живут между сессиями своего браузера |
| `deferred-emails/` | Письма, пришедшие, пока агент был в браузере |
| `usage.jsonl` | Один вызов модели — одна строка |
| `google_token.json` | Формат `google-auth-oauthlib`, его читает скилл Hermes |
| `settings.json` | Модель и флаг автономности, переживают рестарт |

Задачи со статусом `running` или `queued` после рестарта помечаются `failed`: процесс, который их вёл, уже не существует.
