# Деплой

Control plane — приложение Fly `swarm-control-plane` в регионе `ams`. Агенты — отдельные приложения `swarm-<id>`, их создаёт уже работающий control plane, не `fly.toml`.

Сборка идёт из корня репозитория, Dockerfile указан в `fly.toml`. Контекст не должен содержать `node_modules` и `.env`: это закрывает `.dockerignore`.

## Пуш в `main`

Пуш в `main` запускает [`.github/workflows/fly-deploy.yml`](../.github/workflows/fly-deploy.yml). Два задания идут параллельно, каждое ждёт, если предыдущая выкладка того же приложения ещё идёт:

| Задание | Команда |
| --- | --- |
| control plane | `flyctl deploy --remote-only --ha=false` |
| образ runtime | `flyctl deploy --remote-only --build-only --push --image-label latest -c fly.runtime.toml` |

Ручной запуск того же workflow: Actions → Fly Deploy → Run workflow.

В секретах GitHub лежат deploy-токены одного приложения. Их создают так и вставляют в приглашение `gh` (значение в терминал не печатать):

```bash
fly tokens create deploy -a swarm-control-plane -n "github-actions swarm-control-plane" \
  | gh secret set FLY_API_TOKEN --repo cedricIllya/swarmAgent
fly tokens create deploy -a swarm-agent-runtime -n "github-actions swarm-agent-runtime" \
  | gh secret set FLY_RUNTIME_API_TOKEN --repo cedricIllya/swarmAgent
```

`FLY_API_TOKEN` в GitHub — deploy-токен `swarm-control-plane`. Секрет с тем же именем на машине Fly — токен организации `copyboy`: им control plane создаёт приложения агентов. Список и отзыв токенов: `fly tokens list`, `fly tokens revoke <id>`.

Ручная выкладка с своей машины:

```bash
fly deploy --ha=false
```

Перед выкладкой release command `node /migrate/src/migrate.ts` прогоняет Drizzle. Скрипт лежит в образе отдельно от сборки Next, в каталоге `/migrate`, со своими `node_modules`. Node 24 выполняет этот TypeScript напрямую. Пока миграция не прошла, новая машина не запускается.

Машина control plane одна, shared-cpu-1x, 1 GB. `auto_stop_machines = "suspend"` и `min_machines_running = 0`: нет HTTP несколько минут — она засыпает, первый запрос (сайт или вебхук Mailgun) будит. Код в браузер вводит машина агента, ей control plane постоянно не нужен.

Пока control plane не спит, он раз в 15 минут будит агентов, у которых есть свой секрет сервиса, и зовёт `POST /tick`. Пустой тик сразу усыпляет машину агента. Расписание Fly умеет только `hourly`, не каждые 15 минут, поэтому у машины control plane стоит `schedule = hourly`: если сайт давно никто не открывал, Fly будит её примерно раз в час, пропущенная проверка выполняется, и она снова засыпает. `fly deploy` это поле сохраняет; если после выкладки его нет, вернуть так:

```bash
fly machine update <id> --schedule hourly -a swarm-control-plane -y
```

Образ Next собирается как `output: standalone`. `SKILL_TEMPLATE_DIR=/app/agent-template` указывает, откуда брать текст скилла при создании агента.

## Что уже поднято

Приложение, образ runtime и Managed Postgres живут в организации **copyboy**. Агенты создаются туда же: `FLY_ORG` в `fly.toml`.

| | |
| --- | --- |
| Сайт | https://swarm-control-plane.fly.dev |
| Приложение | `swarm-control-plane` |
| База | Managed Postgres `swarm-db`, кластер `kyzl60xz8gyrpj9g`, план Basic, регион `ams` |
| Домен агентов | `cedricillya.online`, DNS у reg.ru (`ns1.reg.ru`, `ns2.reg.ru`) |
| Секреты приложения | `DATABASE_URL`, `AUTH_SECRET`, `SECRETS_KEY`, `OPENROUTER_API_KEY`, `FLY_API_TOKEN`; отложены (`--stage`) `MAILGUN_API_KEY`, `MAILGUN_SIGNING_KEY` |

`APP_URL`, `AGENTS_DOMAIN`, `MAILGUN_REGION`, `FLY_ORG` и `FLY_REGION` записаны в `fly.toml`, не в секретах. Аккаунт Mailgun в регионе US, поэтому `MAILGUN_REGION = "us"`: с дефолтным `eu` API возвращает пустой список доменов. На машине control plane `AGENTS_DOMAIN` и `MAILGUN_REGION` уже выставлены через `fly machine update --env`, следующий `fly deploy` возьмёт те же значения из `fly.toml`.

## Подключение домена агентов

Домен нужен только для почты. Сайт живёт на `swarm-control-plane.fly.dev`; свой hostname для него — отдельный необязательный шаг ниже. MX ставятся на корень `cedricillya.online`: другой почты на нём нет. В этом же аккаунте Mailgun уже живёт `agents.copyboy.ai` с route на `app.copyboy.ai` — это другой продукт, его переиспользовать нельзя.

Ключ Mailgun в `.env` ограниченный: домены и route он читает, но `POST /v4/domains` и `POST /v3/routes` отвечают `401 insufficient permissions`. Для шагов 1 и 3 нужен ключ с ролью Admin или Developer (Mailgun → Settings → API Security → Add new key). Этот же ключ потом идёт в секрет `MAILGUN_API_KEY`: control plane отправляет письма с `no-reply@cedricillya.online`, ограниченному ключу Mailgun на это отвечает 404.

1. В `.env` уже стоят `AGENTS_DOMAIN=cedricillya.online`, `MAILGUN_REGION=us` и `WEBHOOK_URL=https://swarm-control-plane.fly.dev/webhooks/email`. Создать домен в Mailgun:

   ```bash
   pnpm mailgun domain
   ```

   Скрипт напечатает записи для DNS: два MX, TXT с SPF и TXT с DKIM-ключом. Ключ DKIM у каждого домена свой, поэтому до этого шага записи ставить нечего.

2. В панели reg.ru (домен → Управление зоной DNS) добавить записи. Имя `@` означает сам домен:

   | Тип | Имя | Приоритет | Значение |
   | --- | --- | --- | --- |
   | MX | `@` | 10 | `mxa.mailgun.org.` |
   | MX | `@` | 10 | `mxb.mailgun.org.` |
   | TXT | `@` | | `v=spf1 include:mailgun.org ~all` |
   | TXT | `mailo._domainkey` | | `k=rsa; p=…` из вывода скрипта |

   Запись A `cedricillya.online → 45.144.220.188` остаётся. CNAME `email` → `mailgun.org` нужен только для трекинга кликов, можно не ставить.

3. Когда DNS разъехался (`dig +short MX cedricillya.online`, обычно до часа), попросить Mailgun перепроверить и создать route:

   ```bash
   pnpm mailgun verify
   pnpm mailgun route
   pnpm mailgun status   # state=active, записи valid, route → <host>/webhooks/email
   ```

4. Положить ключ в секреты и применить без пересборки:

   ```bash
   fly secrets set --stage -a swarm-control-plane MAILGUN_API_KEY="<admin key>"
   fly secrets deploy -a swarm-control-plane
   ```

5. Проверить: письмо на `anything@cedricillya.online` даёт в `fly logs -a swarm-control-plane` строку вебхука (пока агента с таким адресом нет — запись «агент не найден», это нормально). Агенты, созданные до смены `AGENTS_DOMAIN`, адрес не меняют: у них в `agents.email` остался `@swarm-control-plane.fly.dev`, их нужно пересоздать.

### Свой hostname для сайта (необязательно)

```bash
fly certs add swarm.cedricillya.online -a swarm-control-plane
fly certs show swarm.cedricillya.online -a swarm-control-plane   # покажет, что прописать
```

У регистратора: CNAME `swarm` → `swarm-control-plane.fly.dev.` (или A `66.241.124.32` и AAAA `2a09:8280:1::1a7:254c:0`). Потом в `fly.toml` сменить `APP_URL` на `https://swarm.cedricillya.online`, выложить заново, перезапустить `pnpm mailgun route` с новым `WEBHOOK_URL` и поменять redirect в Google OAuth на `https://swarm.cedricillya.online/api/google/callback`.

Строка подключения к базе — секрет Fly. Её не копируют в репозиторий и в чат. Приложение ходит через PgBouncer (`prepare: false`), миграции — на хост `direct.<cluster>.flympg.net`.

Повторный деплой — пуш в `main`. С своей машины то же самое:

```bash
fly deploy --ha=false
fly logs -a swarm-control-plane
```

Секрет меняется так и не печатается в ответ:

```bash
fly secrets set -a swarm-control-plane AUTH_SECRET="$(openssl rand -base64 32)"
```

`SECRETS_KEY` так менять нельзя: уже записанные токены перестанут расшифровываться.

## Образ runtime

Собран и запушен как `registry.fly.io/swarm-agent-runtime:latest`. Пересобрать:

Для него отдельный файл `fly.runtime.toml`: в нём нет HTTP-сервиса и нет release command. Сборка идёт удалённо, машина не запускается.

```bash
fly apps create swarm-agent-runtime --org copyboy
fly deploy --build-only --push --image-label latest -c fly.runtime.toml
```

Не подставляйте сюда `fly.toml` control plane. Без `--build-only` эта команда выложила бы сайт заново, а не только образ агента. Метка `latest` совпадает с `AGENT_RUNTIME_IMAGE` по умолчанию.

Дальше control plane сможет создавать машины агентов, когда в секретах появится `FLY_API_TOKEN` организации `copyboy` (`fly tokens create org -o copyboy`). Deploy-токена одного приложения недостаточно: код создаёт новое приложение на каждого агента.

Hermes берётся готовым образом `nousresearch/hermes-agent:latest`. Его отдельно собирать не нужно.

## Чего не хватает до полного сценария

1. Свой домен агентов по шагам выше. Секреты Mailgun уже отложены в приложении и применятся первой выкладкой.
2. `BROWSERBASE_API_KEY` и `BROWSERBASE_PROJECT_ID`, если нужен браузер.
3. `SKYVERN_API_KEY`, если нужен вход через Skyvern.
4. `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`, redirect `https://swarm-control-plane.fly.dev/api/google/callback`.

Вход, регистрация и пустой список агентов работают без этих пунктов.
