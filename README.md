# Telegram MCP Starter

Локальный source distribution для подключения Telegram user account к MCP-клиентам. Runtime работает через MTProto и предоставляет инструменты для чтения, поиска, управления сообщениями, чатами и медиа, а также инструменты для Telegram Mini Apps.

## Установка

Требуется Node.js 22 или новее. Используйте поддерживаемый интерактивный установщик: он фиксирует release source по commit SHA, собирает закреплённый runtime и применяет проверяемые расширения.

**macOS / Linux**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.sh)
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.ps1 | iex
```

Эти install URL сохраняются для существующих пользователей. Установщик интерактивно принимает API credentials и пароль 2FA только в локальном терминале; пользователь сканирует QR с телефона. Не присылайте секреты в AI-чат. Полный плейбук для агента: [AGENT.md](AGENT.md).

Upstream npm/npx или бинарник сами по себе не содержат расширений этого дистрибутива. Не используйте прямую upstream install-команду вместо поддерживаемого установщика.

## Возможности и состав

Базовый каталог содержит 180 инструментов; ещё 13 регистрируются только при включении opt-in групп `MCP_TELEGRAM_ENABLE_GROUP_CALLS=1`, `MCP_TELEGRAM_ENABLE_STARS=1` и `MCP_TELEGRAM_ENABLE_QUICK_REPLIES=1` (всего 193). Подробности и имена — [справочник инструментов](docs/TOOLS.md).

Сборка закрепляет `@overpod/mcp-telegram@1.43.1`, alias `telegram` → `teleproto@1.229.0` и Playwright 1.62.1; локальная версия Node должна быть 22+. Runtime включает 17 проверенных postimages: 13 upstream-файлов и 4 файла расширений. Версии и hash allowlist хранятся в [runtime manifest](runtime/manifest.json), описание границ — в [архитектуре](docs/ARCHITECTURE.md).

Playwright package установлен, однако Chromium может отсутствовать. Если Mini App browser-инструмент сообщает об этом, пользователь может установить совместимый browser runtime отдельной командой `npx playwright install chromium` после основной установки. Эта команда скачивает браузер и не запускается установщиком автоматически.

## Проверка

Установщик завершает работу только после авторизованного read-only `doctor --status`: тот вызывает `telegram-status` и требует подтвердить подключённое состояние. Для безопасной диагностики каталога без авторизации:

```bash
node ~/.telegram-mcp/server/doctor.mjs ~/.telegram-mcp/run.sh
```

На Windows передайте `cmd /c` и путь к `run.cmd`. Обычный doctor использует синтетическое окружение, отсутствующий session path и dead loopback proxy; он выполняет MCP initialize + tools/list, не читая аккаунт. Подробно: [проверка](docs/07-verify.md), [устранение неполадок](docs/TROUBLESHOOTING.md).

## Безопасность

Установленная сессия даёт доступ к аккаунту. Защищайте `telegram.env` и файл сессии, не коммитьте и не отправляйте их. Перед отправкой сообщений и другими действиями от имени владельца сверяйте цель и содержание с поручением пользователя. См. [безопасность](docs/SECURITY.md).

## Документы

[Установка macOS](docs/02-macos.md) · [Windows](docs/03-windows.md) · [Linux](docs/04-linux.md) · [Claude Desktop](docs/05-claude-desktop.md) · [Claude Code](docs/06-claude-code.md) · [несколько клиентов](docs/08-multi-agent.md) · [FAQ](docs/FAQ.md) · [архитектура и выпуск](docs/ARCHITECTURE.md).

Существующие lesson URLs и public installer URLs сохраняются. Репозиторий лицензирован по MIT; upstream-компонент и его лицензия описаны в [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
