---
name: pneumatic
description: Рецепт входа в Pneumatic. Публичный REST API, ключ со страницы Integrations.
version: 1
---

# Pneumatic

Рецепт уже известен. Не ищи способ входа заново. Официального MCP у Pneumatic нет — работай через API.
Браузер только если ключ API выпустить не удалось.

## Рецепт

- slug: `pneumatic`
- name: Pneumatic
- kind: `api`
- domains: `pneumatic.app`, `my.pneumatic.app`, `email.pneumatic.app`
- API: `https://api.pneumatic.app`
- docs: `https://api-docs.pneumatic.app/`
- auth: `Authorization: Bearer <api_key>`
- приложение: `https://my.pneumatic.app/`
- вход: `https://my.pneumatic.app/`

Если в каталоге ещё браузерный рецепт или рецепта нет — запиши API-рецепт один раз (пароль из credentials сохранится при merge):

```bash
curl -s -X POST http://127.0.0.1:8787/report -H "Authorization: Bearer $SWARM_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" -d '{"type":"recipe","runId":"<runId>","recipe":{
    "slug":"pneumatic","name":"Pneumatic","kind":"api",
    "domains":["pneumatic.app","my.pneumatic.app","email.pneumatic.app"],
    "api":{"baseUrl":"https://api.pneumatic.app","docsUrl":"https://api-docs.pneumatic.app/","auth":"bearer","authHeader":"Authorization"},
    "browser":{"loginUrl":"https://my.pneumatic.app/","appUrl":"https://my.pneumatic.app/"},
    "notes":"Ключ API: Integrations в кабинете. GET /v3/tasks?assigned_to=<user_id>, POST /workflows/{id}/task-complete","discoveredBy":null}}'
```

## Ключ API

Ключ на странице Integrations в кабинете Pneumatic (`https://my.pneumatic.app/`). Без ключа API не вызывать — 401.
Если вход по приглашению уже есть (пароль в credentials) — открой кабинет своим браузером (`/browser/open` с `serviceSlug":"pneumatic"`), скопируй ключ со страницы Integrations и запиши:

```bash
curl -s -X POST http://127.0.0.1:8787/report -H "Authorization: Bearer $SWARM_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" -d '{"type":"credential","runId":"<runId>","credential":{"slug":"pneumatic","kind":"api","token":"<api_key>","accountEmail":"{{AGENT_EMAIL}}"}}'
```

Секрет в ответ человеку не копируй. Проверь ключ чтением:

```bash
curl -s -H "Authorization: Bearer <api_key>" https://api.pneumatic.app/accounts/users
# → список пользователей; найди свой id по email {{AGENT_EMAIL}}
```

## Задачи

Токен бери из `credentials[].token` (файл services.json или подсказка). После каждого вызова пиши шаг в журнал (`kind: api`).

Список задач на себя:

```bash
# 1) свой user id
curl -s -H "Authorization: Bearer <token>" "https://api.pneumatic.app/accounts/users"
# 2) задачи
curl -s -H "Authorization: Bearer <token>" "https://api.pneumatic.app/v3/tasks?assigned_to=<user_id>"
```

Одна задача:

```bash
curl -s -H "Authorization: Bearer <token>" "https://api.pneumatic.app/v2/tasks/<task_id>"
```

Завершить текущую задачу workflow (изменение — спроси одобрение через `/approval`, если режим не автономный).
Сначала прочитай задачу и workflow, собери `output` по обязательным полям:

```bash
curl -s -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  "https://api.pneumatic.app/workflows/<workflow_id>/task-complete" \
  -d '{"task_id":<task_id>,"output":{}}'
```

Запустить workflow из шаблона:

```bash
curl -s -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  "https://api.pneumatic.app/templates/<template_id>/run" -d '{"kickoff":{}}'
```

Документация и примеры полей — `https://api-docs.pneumatic.app/`. Адреса API не выдумывай.
