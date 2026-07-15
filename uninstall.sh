#!/usr/bin/env bash
# ============================================================================
#  Telegram MCP Starter — полное удаление (macOS / Linux)
#
#  Запуск:
#    bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/uninstall.sh)
#
#  Удаляет: сервер, ключи, сессию, записи в конфигах Claude Code и Claude Desktop.
#  ВАЖНО: после удаления зайдите в Telegram → Настройки → Устройства
#  и завершите сессию «MCP Telegram», если она там осталась.
# ============================================================================
set -euo pipefail

BASE_DIR="$HOME/.telegram-mcp"

read -r -p "Удалить Telegram MCP полностью (папка $BASE_DIR и записи в конфигах)? [y/n]: " answer </dev/tty
case "$answer" in
  [YyДд]*) ;;
  *) echo "Отменено."; exit 0 ;;
esac

# 0. Фоновый сервис (если настраивался)
if [[ -x "$BASE_DIR/daemon-setup.sh" ]]; then
  "$BASE_DIR/daemon-setup.sh" remove >/dev/null 2>&1 || true
fi
# страховка на случай, если скрипт сервиса уже удалён
launchctl bootout "gui/$(id -u)/com.telegram-mcp.daemon" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/com.telegram-mcp.daemon.plist"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now telegram-mcp.service >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/telegram-mcp.service"
fi
echo "✓ Фоновый сервис остановлен и удалён (если был)"

# 1. Claude Code
if command -v claude >/dev/null 2>&1; then
  claude mcp remove telegram -s user >/dev/null 2>&1 && echo "✓ Удалён из Claude Code" || true
fi

# 2. Claude Desktop (с резервной копией)
case "$(uname -s)" in
  Darwin) DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *)      DESKTOP_CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac
MERGER="$BASE_DIR/server/merge-config.mjs"
if [[ -f "$DESKTOP_CFG" && -f "$MERGER" ]] && command -v node >/dev/null 2>&1; then
  node "$MERGER" "$DESKTOP_CFG" --remove || true
fi

# 3. Файлы
if [[ -d "$BASE_DIR" ]]; then
  rm -rf "$BASE_DIR"
  echo "✓ Удалена папка $BASE_DIR (сервер, ключи, сессия)"
fi

echo ""
echo "Готово. Последний шаг — сделайте вручную на телефоне:"
echo "  Telegram → Настройки → Устройства → завершите сессию «MCP Telegram» (если есть)."
echo "Ключи api_id/api_hash на https://my.telegram.org удалять не обязательно."
