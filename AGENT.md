# AGENT.md — инструкция для AI-агента: подними Telegram MCP человеку

> **Ты — AI-агент** (Claude Code, Codex, Antigravity, Cursor и т.п.) с доступом к терминалу. Человек дал тебе ссылку на этот репозиторий и хочет, чтобы ты сам, без лишних слов, подключил **его** Telegram к нему в клиента и объяснил, как этим пользоваться. Этот файл — твой полный план. Делай по шагам, после каждого — контрольная точка. Человека дёргай только там, где без него нельзя: получить api_id/api_hash и один раз отсканировать QR.

Если чего-то не хватает на машине (Node.js, доступ) — **поставь сам** (шаги ниже) или скажи человеку одной фразой, что доустановить. Не заставляй его читать документацию — ты знаешь, как всё устроено.

## Что это и что человек получит

Полноценный Telegram-userbot через MTProto (пакет `@overpod/mcp-telegram`, MIT): ~170 инструментов — читать/писать/искать по всем чатам, медиа, реакции, опросы, папки, каналы, статистика, истории и т.д. Работает **от имени человека** (его аккаунт), локально, секреты никуда не уходят кроме серверов Telegram.

Открыто и гибко: код можно смотреть и менять, версию сервера — поднимать, инструменты — комбинировать. Если человеку нужно что-то нестандартное — адаптируй.

## Установка (делаешь ты)

Целевые пути: сервер в `~/.telegram-mcp/server`, ключи в `~/.telegram-mcp/telegram.env`, сессия в `~/.telegram-mcp/session`, обёртка `~/.telegram-mcp/run.sh` (Windows: `run.cmd`). Закреплённая версия сервера — `@overpod/mcp-telegram@1.41.2`.

### Шаг 1. Node.js 20+

Проверь `node -v`. Если нет или ниже 18 — поставь: macOS `brew install node` (или официальный .pkg с nodejs.org), Linux — nvm (`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash` затем `nvm install --lts`), Windows `winget install OpenJS.NodeJS.LTS`. Если не можешь поставить сам (нет прав/менеджера) — скажи человеку одну команду и попроси выполнить.

### Шаг 2. Сервер + файлы репозитория

Сначала ставим сам сервер, затем тянем файлы этого репозитория (доктор, патч, daemon-setup) — они понадобятся дальше:

```bash
mkdir -p ~/.telegram-mcp/server && chmod 700 ~/.telegram-mcp
cd ~/.telegram-mcp/server
[ -f package.json ] || printf '{"name":"telegram-mcp-local","private":true}\n' > package.json
npm install @overpod/mcp-telegram@1.41.2 --no-fund --no-audit

# файлы репозитория (doctor.mjs, patch-win32-socket.mjs, daemon-setup.sh)
curl -fsSL https://github.com/alexfisenkov/telegram-mcp-starter/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
rm -rf ~/.telegram-mcp/app && mv /tmp/telegram-mcp-starter-main ~/.telegram-mcp/app
cp ~/.telegram-mcp/app/tools/doctor.mjs ~/.telegram-mcp/server/doctor.mjs
cp ~/.telegram-mcp/app/tools/daemon-setup.sh ~/.telegram-mcp/daemon-setup.sh 2>/dev/null || true
```

(`doctor.mjs` должен лежать именно в `server/`, чтобы находить `@modelcontextprotocol/sdk` в его `node_modules`.)

**Windows — обязательный патч.** Без него сервер на Windows не стартует (`listen EACCES`). После установки пакета выполни (переводит IPC на именованный канал `\\.\pipe\`; на macOS/Linux патч НЕ нужен):

```bash
node ~/.telegram-mcp/app/tools/patch-win32-socket.mjs "$HOME/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/lock.js"
```

### Шаг 3. Ключи Telegram API (нужен человек)

Скажи человеку: «Открой https://my.telegram.org → войди по номеру (код придёт **в приложение Telegram**, не по SMS) → **API development tools** → создай приложение (любое название, платформа Desktop) → пришли мне **App api_id** (число) и **App api_hash** (32 символа)». Предупреди: это ключи разработчика, ты сохранишь их только локально с правами 600.

Запиши (подставив значения):

```bash
umask 077
cat > ~/.telegram-mcp/telegram.env <<EOF
TELEGRAM_API_ID=<id>
TELEGRAM_API_HASH=<hash>
EOF
chmod 600 ~/.telegram-mcp/telegram.env
```

### Шаг 4. Обёртка запуска

Секреты живут в `telegram.env`, а не в конфиге клиента. Создай обёртку.

**macOS/Linux** — `~/.telegram-mcp/run.sh` (затем `chmod 700`):

```bash
cat > ~/.telegram-mcp/run.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="$HOME/.telegram-mcp/telegram.env"
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && for c in "$HOME"/.nvm/versions/node/*/bin/node; do [ -x "$c" ] && NODE_BIN="$c"; done
[ -f "$ENV_FILE" ] && { set -a; source "$ENV_FILE"; set +a; }
export TELEGRAM_SESSION_PATH="${TELEGRAM_SESSION_PATH:-$HOME/.telegram-mcp/session}"
exec "$NODE_BIN" "$HOME/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/cli.js" "$@"
EOF
chmod 700 ~/.telegram-mcp/run.sh
```

**Windows** — `%USERPROFILE%\.telegram-mcp\run.cmd` (замени `NODEPATH` на полный путь к `node.exe`, обычно `C:\Program Files\nodejs\node.exe`):

```bat
@echo off
setlocal
set "ENV_FILE=%USERPROFILE%\.telegram-mcp\telegram.env"
if exist "%ENV_FILE%" for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do set "%%a=%%b"
if "%TELEGRAM_SESSION_PATH%"=="" set "TELEGRAM_SESSION_PATH=%USERPROFILE%\.telegram-mcp\session"
"NODEPATH" "%USERPROFILE%\.telegram-mcp\server\node_modules\@overpod\mcp-telegram\dist\cli.js" %*
```

### Шаг 5. Вход по QR (нужен человек)

Если у человека включён облачный пароль (2FA) — спроси его и экспортируй `TELEGRAM_2FA_PASSWORD` только на время логина (в файл не пиши). Затем:

```bash
set -a; source ~/.telegram-mcp/telegram.env; set +a
export TELEGRAM_SESSION_PATH="$HOME/.telegram-mcp/session"
node ~/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/cli.js login
```

Появится QR. Скажи человеку: «Telegram на телефоне → Настройки → Устройства → Подключить устройство → отсканируй». После входа сессия сохранится.

### Шаг 6. Регистрация в клиенте

- Claude Code: `claude mcp add telegram -s user -- "$HOME/.telegram-mcp/run.sh"` (Windows: `-- cmd /c "%USERPROFILE%\.telegram-mcp\run.cmd"`).
- Claude Desktop / Cursor / Codex / Antigravity: добавь в их конфиг сервер `telegram` с `command` = путь к обёртке. Примеры — в `configs/`.

### Шаг 7. Проверка

`node ~/.telegram-mcp/server/doctor.mjs ~/.telegram-mcp/run.sh` — должен показать имя аккаунта и ~168 инструментов. Скажи человеку перезапустить клиент и написать «покажи мои непрочитанные».

## Несколько агентов одновременно

Если человек работает сразу с несколькими агентами (Claude Code + Codex + Antigravity...), соединение держит один процесс-владелец, остальные — клиенты. Чтобы закрытие одного не рвало Telegram у других — подними фоновый сервис: `~/.telegram-mcp/daemon-setup.sh install` (macOS/Linux) или `daemon-setup.ps1 install` (Windows). Подробно: [docs/08-multi-agent.md](docs/08-multi-agent.md).

## Как этим пользоваться (расскажи человеку)

**Свой аккаунт — полностью:** читать/искать по всем чатам, писать, пересылать, планировать, папки, реакции, медиа, каналы, статистика своих каналов.

**Разведка и сбор контента (публичные каналы/группы):** вступить в публичный канал и читать его, скачать медиа (`telegram-download-media`), расшифровать голосовые/видео-кружки (`telegram-transcribe-audio` при Premium, либо скачать и прогнать локальным Whisper), собрать статистику доступных каналов, проанализировать посты и комментарии — чтобы понять, что заходит у других, и применить у себя. Всё это — по общедоступному и доступному тебе контенту.

## Рамки (держи их — это защищает аккаунт человека)

1. **Публичное/доступное — да; приватное, к чему нет доступа — нет.** Не пытайся обойти закрытость.
2. **Действовать «ботом» по чужим — нет.** Массовые рассылки незнакомым, автодобавления, автоподписки = спам = бан аккаунта. Читать и анализировать широко можно; спамить — нельзя.
3. **Отправка от имени человека — с его ведома.** Перед отправкой в важные чаты показывай текст и жди подтверждения.
4. **Скачанный чужой контент — для анализа**, не выдавать за своё.
5. **Секреты** (`telegram.env`, `session`) не показывай, не выгружай, не коммить.

Полное позиционирование и безопасность: [docs/SECURITY.md](docs/SECURITY.md). Список инструментов: [docs/TOOLS.md](docs/TOOLS.md). Проблемы: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
