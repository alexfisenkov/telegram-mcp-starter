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

## Запуск без Node.js (готовые бинарники)

У исходного проекта есть самодостаточные бинарники — один файл, никаких зависимостей:

| Платформа | Сервер | Логин |
|-----------|--------|-------|
| macOS Apple Silicon | `mcp-telegram-darwin-arm64` | `mcp-telegram-login-darwin-arm64` |
| macOS Intel | `mcp-telegram-darwin-x64` | `mcp-telegram-login-darwin-x64` |
| Windows x64 | `mcp-telegram-windows-x64.exe` | `mcp-telegram-login-windows-x64.exe` |
| Linux x64 | `mcp-telegram-linux-x64` | `mcp-telegram-login-linux-x64` |
| Linux ARM64 | `mcp-telegram-linux-arm64` | `mcp-telegram-login-linux-arm64` |

Скачать со [страницы Releases](https://github.com/mcp-telegram/mcp-telegram/releases/latest) и переименовать (пример для macOS Apple Silicon — подставьте свою платформу из таблицы):

```bash
curl -L -o mcp-telegram       https://github.com/mcp-telegram/mcp-telegram/releases/latest/download/mcp-telegram-darwin-arm64
curl -L -o mcp-telegram-login https://github.com/mcp-telegram/mcp-telegram/releases/latest/download/mcp-telegram-login-darwin-arm64
chmod +x mcp-telegram mcp-telegram-login
TELEGRAM_API_ID=ВАШ_ID TELEGRAM_API_HASH=ВАШ_HASH ./mcp-telegram-login   # QR-вход
# в конфиге клиента: "command": "/полный/путь/mcp-telegram" + env-переменные
```

> macOS может заблокировать неподписанный бинарник (Gatekeeper): Системные настройки → Конфиденциальность и безопасность → «Разрешить». Наш основной путь через Node.js этой проблемы не имеет.

## Другие MCP-клиенты

Наша обёртка (`run.sh` / `run.cmd`) — обычная MCP stdio-команда, она работает в любом клиенте. Готовые примеры лежат в [configs/](../configs/):

- **Cursor:** Settings → MCP → Add new global MCP server → вставьте JSON из `configs/cursor.example.json` (файл `~/.cursor/mcp.json`).
- **VS Code (GitHub Copilot):** команда `MCP: Add Server` или файл `.vscode/mcp.json` — пример в `configs/vscode.example.json`.
- **Codex CLI:** блок в `~/.codex/config.toml` — пример в `configs/codex.example.toml`.

## Смена закреплённой версии сервера

Установщик ставит версию, зафиксированную в переменной `PKG_VERSION` в начале скрипта (сейчас `1.41.2`) — чтобы у всего потока учеников было одинаковое, проверенное окружение. Продвинутые пользователи могут обновиться самостоятельно:

```bash
npm install --prefix ~/.telegram-mcp/server @overpod/mcp-telegram@latest
```

Список изменений: [CHANGELOG проекта](https://github.com/mcp-telegram/mcp-telegram/blob/main/CHANGELOG.md).
