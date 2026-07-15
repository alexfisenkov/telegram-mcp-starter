# Подключение к Claude Desktop (вручную)

Установщик делает это автоматически (и с резервной копией). Эта страница — если вы хотите настроить вручную или проверить, что записано в конфиге.

## Где лежит конфиг

| ОС | Путь |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` (обычно `C:\Users\<вы>\AppData\Roaming\Claude\...`) |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Быстро открыть в Claude Desktop: **Settings → Developer → Edit Config**.

## Что добавить

Наш подход: **в конфиге нет ни одного секрета** — только путь к скрипту-обёртке, а ключи лежат отдельно в `telegram.env`. Если вы когда-нибудь поделитесь скриншотом конфига, ключи не утекут.

### macOS / Linux

```json
{
  "mcpServers": {
    "telegram": {
      "command": "/Users/ВАШЕ_ИМЯ/.telegram-mcp/run.sh"
    }
  }
}
```

Замените `/Users/ВАШЕ_ИМЯ` на свой домашний каталог (узнать: `echo $HOME` в терминале). На Linux это будет `/home/ВАШЕ_ИМЯ`.

### Windows

```json
{
  "mcpServers": {
    "telegram": {
      "command": "cmd",
      "args": ["/c", "C:\\Users\\ВАШЕ_ИМЯ\\.telegram-mcp\\run.cmd"]
    }
  }
}
```

Замените `ВАШЕ_ИМЯ` на имя пользователя Windows (узнать: `echo $env:USERNAME` в PowerShell). Обратите внимание на **двойные** обратные слэши `\\`.

> В конфиге уже есть другие серверы? Добавьте блок `"telegram": {...}` внутрь существующего `"mcpServers"`, через запятую. Готовые полные примеры: [configs/](../configs/).

## После правки

1. Сохраните файл.
2. **Полностью** перезапустите Claude Desktop: macOS — Cmd+Q; Windows — правой кнопкой по значку в трее → выход. Просто закрыть окно недостаточно!
3. Напишите Claude: «Выполни telegram-status».

## Автоматический способ (то же, что делает установщик)

```bash
# macOS / Linux
node ~/.telegram-mcp/server/merge-config.mjs \
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  "$HOME/.telegram-mcp/run.sh"
```

```powershell
# Windows
node "$env:USERPROFILE\.telegram-mcp\server\merge-config.mjs" `
  "$env:APPDATA\Claude\claude_desktop_config.json" `
  cmd /c "$env:USERPROFILE\.telegram-mcp\run.cmd"
```

Скрипт делает резервную копию конфига (`*.backup-<дата>`) перед каждым изменением.
