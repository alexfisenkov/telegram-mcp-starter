# Несколько AI-агентов одновременно (Claude Code + Codex + Antigravity + …)

Хотите, чтобы с вашим Telegram работали сразу несколько агентов — Claude Desktop, пара окон Claude Code, Codex, Cursor, Antigravity? Это поддерживается, но важно понимать, как устроена защита соединения.

## Почему это вообще проблема

Telegram-сессию (файл `session`) может держать **только один процесс одновременно**. Если два процесса откроют одну сессию, Telegram аннулирует её у обоих с ошибкой `AUTH_KEY_DUPLICATED` — и придётся входить заново.

## Что уже встроено (работает из коробки)

Наш сервер сам решает эту проблему по принципу «**один владелец, остальные — клиенты**»:

```
Claude Desktop ──┐
Claude Code   ───┼──► клиенты ──► ВЛАДЕЛЕЦ соединения ──► Telegram
Codex         ───┘                (один процесс)
```

Первый запустившийся процесс захватывает файл-замок (`daemon.lock`) и становится **владельцем** — только он держит соединение с Telegram. Все остальные запуски автоматически видят замок и становятся **клиентами**: они проксируют запросы владельцу через локальный канал (`daemon.sock` на macOS/Linux, именованный канал на Windows). Никаких настроек для этого не нужно.

**Слабое место:** без фонового сервиса владельцем становится случайный агент — тот, что запустился первым. Закроете его — соединение оборвётся, и у всех остальных агентов Telegram отвалится до переподключения (обычно нужно перезапустить агента или переподключить MCP).

## Рекомендация: фоновый сервис (для 2+ агентов)

Фоновый сервис — это постоянный процесс-владелец, который стартует при входе в систему и не зависит ни от одного агента. Все агенты всегда клиенты; закрытие любого из них ни на что не влияет.

Установщик предлагает настроить его на шаге 6. Вручную — в любой момент:

```bash
# macOS / Linux
~/.telegram-mcp/daemon-setup.sh install    # установить и запустить
~/.telegram-mcp/daemon-setup.sh status     # проверить
~/.telegram-mcp/daemon-setup.sh restart    # перезапустить (после повторного входа в Telegram)
~/.telegram-mcp/daemon-setup.sh remove     # удалить
```

```powershell
# Windows
powershell "$env:USERPROFILE\.telegram-mcp\daemon-setup.ps1" install
powershell "$env:USERPROFILE\.telegram-mcp\daemon-setup.ps1" status
```

Под капотом: macOS — launchd (LaunchAgent, автоперезапуск при сбое), Linux — systemd user unit, Windows — Планировщик заданий (запуск при входе, без чёрного окна). Лог на macOS/Linux: `~/.telegram-mcp/daemon.log`.

## Как подключить каждого агента

Все агенты подключаются **одинаково** — к одной и той же обёртке. Никаких отдельных сессий на агента создавать не нужно (отдельные сессии нужны только для отдельных *аккаунтов* — см. [ADVANCED.md](ADVANCED.md#несколько-аккаунтов)).

| Агент | Как подключить |
|-------|----------------|
| **Claude Code** | `claude mcp add telegram -s user -- "$HOME/.telegram-mcp/run.sh"` (Windows: `claude mcp add telegram -s user -- cmd /c "%USERPROFILE%\.telegram-mcp\run.cmd"`) — [подробнее](06-claude-code.md) |
| **Claude Desktop** | [05-claude-desktop.md](05-claude-desktop.md) — установщик делает сам |
| **Codex CLI** | блок в `~/.codex/config.toml` — пример [configs/codex.example.toml](../configs/codex.example.toml) |
| **Cursor** | `~/.cursor/mcp.json` — пример [configs/cursor.example.json](../configs/cursor.example.json) |
| **VS Code (Copilot)** | `.vscode/mcp.json` — пример [configs/vscode.example.json](../configs/vscode.example.json) |
| **Antigravity** | панель агента → значок ⚙/MCP → Manage MCP servers → View raw config — вставьте блок из [configs/antigravity.example.json](../configs/antigravity.example.json) |

Во всех конфигах — только путь к `run.sh`/`run.cmd`, без секретов.

## Частые вопросы

**Сколько агентов можно одновременно?** Практически сколько угодно — все они клиенты одного владельца. Лимиты скорости Telegram (FLOOD_WAIT) общие на аккаунт, так что если все агенты одновременно активно пишут — Telegram попросит подождать.

**Я вошёл в Telegram заново (новый QR). Агенты отвалились?** Фоновый сервис держит старую сессию в памяти — перезапустите его: `daemon-setup.sh restart` (установщик делает это сам при повторном входе).

**Как проверить, кто сейчас владелец?** `daemon-setup.sh status` (macOS/Linux) или `daemon-setup.ps1 status` (Windows). Без сервиса владелец — первый запущенный агент; в его логах будет `Starting as master process`, у остальных — `Starting as client process`.

**AUTH_KEY_DUPLICATED всё равно вылезло. Как?** Значит, два процесса открыли сессию в обход замка — обычно это две РАЗНЫЕ папки сессии, указывающие на один аккаунт (например, вы вручную создали вторую копию). Держите одну папку `~/.telegram-mcp` на аккаунт — и замок сделает всё сам. Лечение: [TROUBLESHOOTING.md](TROUBLESHOOTING.md#auth_key_duplicated).
