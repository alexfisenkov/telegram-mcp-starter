# Подключение к Claude Code (вручную)

Установщик делает это автоматически. Эта страница — если хотите подключить вручную, перепроверить или подключить в область проекта.

## Одна команда

### macOS / Linux

```bash
claude mcp add telegram -s user -- "$HOME/.telegram-mcp/run.sh"
```

### Windows (PowerShell)

```powershell
claude mcp add telegram -s user -- cmd /c "$env:USERPROFILE\.telegram-mcp\run.cmd"
```

Флаг `-s user` подключает сервер **для всех ваших проектов**. Если нужен только в одном проекте — уберите флаг и выполните команду в папке проекта.

Секретов в конфиге Claude Code при этом нет: команда указывает на скрипт-обёртку, а ключи тот берёт из `~/.telegram-mcp/telegram.env`.

## Проверка

```bash
claude mcp list          # в списке должен быть telegram
claude mcp get telegram  # показать настройки
```

Внутри сессии Claude Code: наберите `/mcp` — сервер `telegram` должен быть в статусе connected. Затем напишите: «Выполни telegram-status».

## Удалить из Claude Code

```bash
claude mcp remove telegram -s user
```

## Runtime и обновление

Подключайте только установленную обёртку `run.sh` / `run.cmd`. Прямой запуск через `npx`, самостоятельную установку npm-пакета или upstream binary обходит lockfile и hash-bound расширения Starter. Для обновления повторно запустите поддерживаемый `install.sh` или `install.ps1`; установщик сохраняет ключи и сессию, если оставить их при вопросах и не входить заново.

## Другие MCP-клиенты

Обёртка является MCP stdio-командой и работает в поддерживающих stdio клиентах. Примеры конфигов лежат в [configs/](../configs/): Cursor, VS Code и Codex.
