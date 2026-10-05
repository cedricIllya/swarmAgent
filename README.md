# Swarm Agent

Сервис, в котором у пользователя несколько AI-агентов. У каждого агента свой адрес на общем домене Mailgun и своя машина на Fly.io с [Hermes Agent](https://github.com/NousResearch/hermes-agent). Машина засыпает, когда работы нет: процессор и память в этом состоянии не тарифицируются. На адрес присылают приглашение в сервис — агент входит по лестнице **MCP → API → браузер**, онбордится и дальше проверяет задачи в подключённых сервисах. Модели берутся из OpenRouter.

Сейчас control plane открыт на [swarm.cedricillya.online](https://swarm.cedricillya.online). Адрес `swarm-control-plane.fly.dev` отвечает 404. Почта и машины агентов ещё не подключены: нет своего домена с MX и не собран образ runtime. Подробности в [деплое](docs/deploy.md).

## Документация

| | |
| --- | --- |
| [Архитектура](docs/architecture.md) | Кто с кем говорит, границы пакетов, лестница входа в сервис |
| [Данные](docs/data.md) | PostgreSQL и файлы на диске агента |
| [Почта](docs/mail.md) | Адрес, Mailgun, вебхук, три двери обработки письма |
| [Runtime](docs/runtime.md) | Процесс на машине агента: почта, браузер, Hermes, тик |
| [Control plane](docs/control-plane.md) | Страницы, API, создание и удаление агента |
| [Конфигурация](docs/configuration.md) | Переменные окружения |
| [Локальный запуск](docs/local.md) | Postgres, веб и runtime на своей машине |
| [Деплой](docs/deploy.md) | Fly, база, что уже поднято и чего не хватает |

## Репозиторий

```
apps/web              Next.js: вход, карточка агента, API, вебхук почты
apps/agent-runtime    процесс на машине агента
packages/contracts    общие zod-схемы
packages/db           PostgreSQL и Drizzle
packages/crypto       AES-256-GCM
packages/identity     better-auth и тенанты
packages/agents       реестр агентов
packages/mail         адрес, подпись, нормализация, отправка
packages/connections  каталог рецептов и секреты тенанта
packages/fly          Machines API
packages/google       OAuth и google_token.json
packages/usage        токены и деньги по задачам
packages/hermes-config  config.yaml, .env, cron, скилл
agent-template/       SKILL.md, который кладётся на машину агента
scripts/mailgun.ts    домен и route в Mailgun
fly.toml              control plane
fly.runtime.toml      сборка образа агента, без выкладки сайта
```

`apps/agent-runtime` импортирует только `contracts` и `usage`. Остальные пакеты не импортируют друг друга, кроме `contracts`, `db` и `crypto`.

## Команды

```bash
pnpm install
pnpm dev            # control plane, http://localhost:3000
pnpm dev:runtime    # процесс агента, нужны переменные из docs/local.md
pnpm typecheck
pnpm test
pnpm db:generate    # новая миграция Drizzle
pnpm db:migrate
pnpm mailgun status # почта: status | domain | verify | route
```
