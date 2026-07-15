# Готовые примеры конфигов

Во всех примерах замените `ВАШЕ_ИМЯ` на имя вашего пользователя:
- macOS: домашняя папка — `/Users/ВАШЕ_ИМЯ` (узнать: `echo $HOME`)
- Linux: `/home/ВАШЕ_ИМЯ`
- Windows: `C:\Users\ВАШЕ_ИМЯ` (узнать: `echo $env:USERPROFILE` в PowerShell)

| Файл | Клиент | Куда вставлять |
|------|--------|----------------|
| `claude_desktop_macos_linux.example.json` | Claude Desktop (macOS/Linux) | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) или `~/.config/Claude/claude_desktop_config.json` (Linux) |
| `claude_desktop_windows.example.json` | Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| `cursor.example.json` | Cursor (macOS/Linux) | `~/.cursor/mcp.json` (или Settings → MCP) |
| `cursor_windows.example.json` | Cursor (Windows) | `C:\Users\ВАШЕ_ИМЯ\.cursor\mcp.json` |
| `vscode.example.json` | VS Code, Copilot MCP (macOS/Linux) | `.vscode/mcp.json` в проекте или через команду `MCP: Add Server` |
| `vscode_windows.example.json` | VS Code, Copilot MCP (Windows) | `.vscode/mcp.json` в проекте |
| `codex.example.toml` | Codex CLI | блок в `~/.codex/config.toml` |
| `antigravity.example.json` | Antigravity | панель агента → MCP → Manage MCP servers → View raw config (на Windows `command`/`args` — как в `claude_desktop_windows.example.json`) |

Claude Code подключается командой, файл не нужен — см. [docs/06-claude-code.md](../docs/06-claude-code.md).

**Важно:** ни в один конфиг не нужно вписывать api_id/api_hash — секреты живут в `~/.telegram-mcp/telegram.env`, их подхватывает скрипт-обёртка `run.sh`/`run.cmd`. Конфиги можно спокойно показывать — секретов в них нет.
