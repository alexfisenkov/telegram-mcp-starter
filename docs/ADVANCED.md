# Продвинутые сценарии

Базовая установка покрывает 95% случаев. Здесь — всё остальное.

## Несколько аккаунтов

Каждому аккаунту — **своя папка** с сессией и своя запись в конфиге клиента. Отдельная папка обязательна: рядом с сессией сервер держит служебные файлы общего daemon (`daemon.lock`, `daemon.sock`), и две сессии в одной папке будут конфликтовать.

> **Важно:** перед входом во второй аккаунт закройте все клиенты Claude (чтобы остановить работающий сервер основного аккаунта), иначе вход может «уйти» в уже запущенный процесс.

```bash
# Вход во второй аккаунт (macOS/Linux) — отдельная ПАПКА для сессии:
mkdir -p ~/.telegram-mcp/work && chmod 700 ~/.telegram-mcp/work
set -a; source ~/.telegram-mcp/telegram.env; set +a
TELEGRAM_SESSION_PATH=~/.telegram-mcp/work/session \
  node ~/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/cli.js login
# если на втором аккаунте включён 2FA — добавьте перед командой TELEGRAM_2FA_PASSWORD='пароль'
```

> api_id/api_hash можно использовать одни и те же для обоих аккаунтов, а можно получить отдельные со второго аккаунта на my.telegram.org — оба варианта работают.

Затем сделайте копию обёртки под второй аккаунт:

```bash
cp ~/.telegram-mcp/run.sh ~/.telegram-mcp/run-work.sh
# в копии замените строку export TELEGRAM_SESSION_PATH=... на:
#   export TELEGRAM_SESSION_PATH="$HOME/.telegram-mcp/work/session"
```

И подключите как второй сервер:

```bash
claude mcp add telegram-work -s user -- "$HOME/.telegram-mcp/run-work.sh"
```

В Claude Desktop — второй блок в `mcpServers` с именем `telegram-work`.

## Общий daemon: несколько клиентов — один аккаунт

Полностью описано в **[08-multi-agent.md](08-multi-agent.md)**: сервер сам работает по схеме «один владелец — остальные клиенты», а готовый фоновый сервис с автостартом ставится одной командой:

```bash
~/.telegram-mcp/daemon-setup.sh install     # macOS (launchd) / Linux (systemd)
```

```powershell
powershell "$env:USERPROFILE\.telegram-mcp\daemon-setup.ps1" install   # Windows (Планировщик)
```

Запуск руками без сервиса (например, в tmux): `~/.telegram-mcp/run.sh serve`. Официальный гайд апстрима: [shared-daemon](https://mcp-telegram.github.io/mcp-telegram/guides/shared-daemon).

## Прокси (SOCKS5 / MTProxy)

Если Telegram блокируется в вашей сети, добавьте в `~/.telegram-mcp/telegram.env`:

```bash
# SOCKS5:
TELEGRAM_PROXY_IP=127.0.0.1
TELEGRAM_PROXY_PORT=10808
# при необходимости:
# TELEGRAM_PROXY_USERNAME=...
# TELEGRAM_PROXY_PASSWORD=...

# ЛИБО MTProxy (секрет включает режим MTProxy):
# TELEGRAM_PROXY_IP=proxy.example.com
# TELEGRAM_PROXY_PORT=443
# TELEGRAM_PROXY_SECRET=ee...
```

После правки перезапустите Claude. Прокси нельзя совмещать с `TELEGRAM_USE_WSS`.

## Порт 443 вместо 80 (VPS/хостинги)

Некоторые хостинги режут исходящий порт 80 к IP-диапазонам Telegram — подключение висит на `Connecting to ...:80/TCPFull`. Лекарство — строка в `telegram.env`:

```
TELEGRAM_USE_WSS=true
```

## Поддерживаемый запуск

Upstream бинарники и прямые `npm`/`npx` команды не включают расширения Starter и не являются поддерживаемым способом установки. Используйте Node.js 22+ и официальный install script; он закрепляет зависимости и проверяет postimages. Для локального Mini App UI дополнительно может понадобиться `npx playwright install chromium`; установщик сам браузер не скачивает.

## Другие MCP-клиенты

Наша обёртка (`run.sh` / `run.cmd`) — обычная MCP stdio-команда, она работает в любом клиенте. Готовые примеры лежат в [configs/](../configs/):

- **Cursor:** Settings → MCP → Add new global MCP server → вставьте JSON из `configs/cursor.example.json` (файл `~/.cursor/mcp.json`).
- **VS Code (GitHub Copilot):** команда `MCP: Add Server` или файл `.vscode/mcp.json` — пример в `configs/vscode.example.json`.
- **Codex CLI:** блок в `~/.codex/config.toml` — пример в `configs/codex.example.toml`.

## Обновление

Повторно запустите `install.sh` или `install.ps1`. Не обновляйте npm-пакет отдельно от закреплённого дистрибутива.
