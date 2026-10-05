---
name: gensite
description: Рецепт входа в Gensite. Удалённый MCP, токен из кабинета, регистрация только через /report.
version: 1
---

# Gensite

Рецепт уже известен. Не ищи способ входа заново и не регистрируй MCP командой `hermes mcp`
или кодом `import hermes_tools`.

Модуля `hermes_tools` в терминале нет: он появляется только внутри `execute_code`, а на этой
машине `execute_code` выключен. Ошибка `No module named 'hermes_tools'` значит, что регистрация
пошла не тем путём.

## Рецепт

- slug: `gensite`
- name: Gensite
- kind: `mcp`
- domains: `gensite.ru`
- url: `https://gensite.ru/api/mcp`
- transport: `streamable_http`
- auth: `bearer`

Если этого рецепта ещё нет в каталоге, запиши его один раз:

```bash
curl -s -X POST http://127.0.0.1:8787/report -H "Authorization: Bearer $SWARM_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" -d '{"type":"recipe","recipe":{
    "slug":"gensite","name":"Gensite","kind":"mcp","domains":["gensite.ru"],
    "mcp":{"url":"https://gensite.ru/api/mcp","transport":"streamable_http","auth":"bearer","includeTools":[]},
    "notes":"Токен gs1 из кабинета: Настройки → MCP. Отдельного login в MCP нет.","discoveredBy":null}}'
```

## Токен

Без токена сервер отвечает 401 «Нужен токен аккаунта». Это не поломка регистрации.
Токен выпускается в кабинете Gensite: Настройки → MCP. Отдельного `login` в MCP нет.
Если кабинет пишет, что заявка на регистрацию ждёт одобрения, — токен ещё не выпускай и не останавливайся на «подожду»: карточка в чате продолжит вход после одобрения.
URL не заменяй на localhost: `command` и `npx` не нужны, это удалённый HTTP MCP.

Получил токен — запиши свой доступ:

```bash
curl -s -X POST http://127.0.0.1:8787/report -H "Authorization: Bearer $SWARM_RUNTIME_TOKEN" \
  -H "Content-Type: application/json" -d '{"type":"credential","credential":{"slug":"gensite","kind":"mcp","token":"<gs1-токен>","accountEmail":"{{AGENT_EMAIL}}"}}'
```

После `/report` runtime сам допишет `Authorization` в конфиг. Инструменты появятся как
`mcp_gensite_*`. Первыми вызывай `whoami` и `get_product_guide`. Секрет в ответ человеку не копируй.
