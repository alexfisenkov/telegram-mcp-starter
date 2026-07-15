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

## Официальный альтернативный способ (без обёртки)

Так советует README самого пакета — ключи попадут в конфиг Claude Code в открытом виде. Работает, но наш способ с обёрткой безопаснее (нельзя случайно «засветить» ключи на скриншоте конфига):

```bash
claude mcp add telegram -s user \
  -e TELEGRAM_API_ID=ВАШ_ID \
  -e TELEGRAM_API_HASH=ВАШ_HASH \
  -e TELEGRAM_SESSION_PATH="$HOME/.telegram-mcp/session" \
  -- npx @overpod/mcp-telegram@1.41.2
```

Версию указываем ту же, что ставит установщик (1.41.2), чтобы у всего потока было одинаковое окружение.
