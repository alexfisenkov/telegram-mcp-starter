#!/usr/bin/env bash
# ============================================================================
#  Telegram MCP — постоянный фоновый сервис (macOS: launchd, Linux: systemd)
#
#  Зачем: когда с одним Telegram-аккаунтом работают НЕСКОЛЬКО AI-агентов
#  одновременно (Claude Code + Claude Desktop + Codex + Cursor...), соединение
#  с Telegram может держать только один процесс. Без сервиса владельцем
#  становится первый запустившийся агент — закроешь его, и Telegram отвалится
#  у всех остальных. Сервис же ВСЕГДА владеет соединением: агенты подключаются
#  к нему как клиенты, и закрытие любого из них ни на что не влияет.
#
#  Использование:
#    daemon-setup.sh install    установить и запустить (автостарт при входе)
#    daemon-setup.sh remove     остановить и удалить
#    daemon-setup.sh restart    перезапустить (после повторного входа в Telegram)
#    daemon-setup.sh status     показать состояние
#
#  Установщик install.sh кладёт копию этого скрипта в ~/.telegram-mcp/.
# ============================================================================
set -euo pipefail

CMD="${1:-install}"
BASE="$HOME/.telegram-mcp"
RUN="$BASE/run.sh"
LOG="$BASE/daemon.log"
OWNER_LOCK="$BASE/daemon.lock"

if [[ ! -x "$RUN" ]]; then
  echo "✗ Нет $RUN — сначала запустите install.sh" >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

read_owner_pid() {
  local pid=""
  if [[ -f "$OWNER_LOCK" ]]; then
    IFS= read -r pid < "$OWNER_LOCK" || true
  fi
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && printf '%s' "$pid"
}

wait_for_owner_restart() {
  local old_pid="$1" new_pid="" i
  for ((i = 0; i < 100; i += 1)); do
    new_pid="$(read_owner_pid || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      sleep 0.2
      continue
    fi
    if [[ -n "$new_pid" && ( -z "$old_pid" || "$new_pid" != "$old_pid" ) ]] && kill -0 "$new_pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "✗ Не подтвердился новый владелец Telegram после перезапуска службы. Проверьте $OWNER_LOCK и лог $LOG." >&2
  return 1
}

case "$(uname -s)" in
  Darwin)
    LABEL="com.telegram-mcp.daemon"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    DOMAIN="gui/$(id -u)"
    RUN_XML="$(xml_escape "$RUN")"
    LOG_XML="$(xml_escape "$LOG")"
    case "$CMD" in
      install)
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUN_XML</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
</dict>
</plist>
PLIST_EOF
        launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        launchctl bootstrap "$DOMAIN" "$PLIST"
        launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        echo "✓ Сервис установлен и запущен (автостарт при входе в систему). Лог: $LOG"
        ;;
      remove)
        launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        rm -f "$PLIST"
        echo "✓ Сервис остановлен и удалён"
        ;;
      restart)
        OLD_OWNER_PID="$(read_owner_pid || true)"
        launchctl kickstart -k "$DOMAIN/$LABEL"
        wait_for_owner_restart "$OLD_OWNER_PID"
        echo "✓ Служба перезапущена; новый владелец PID $(read_owner_pid) подтверждён"
        ;;
      status)
        launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,12p' || echo "Сервис не установлен"
        ;;
      *)
        echo "Использование: daemon-setup.sh [install|remove|restart|status]" >&2
        exit 2
        ;;
    esac
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/telegram-mcp.service"
    RUN_UNIT="${RUN//\\/\\\\}"
    RUN_UNIT="${RUN_UNIT//\"/\\\"}"
    RUN_UNIT="${RUN_UNIT//%/%%}"
    case "$CMD" in
      install)
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Telegram MCP daemon (connection owner)

[Service]
ExecStart="$RUN_UNIT" serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT_EOF
        systemctl --user daemon-reload
        systemctl --user enable --now telegram-mcp.service
        echo "✓ Сервис установлен и запущен. Статус: systemctl --user status telegram-mcp"
        echo "  Если это сервер без входа в GUI — включите linger: sudo loginctl enable-linger $USER"
        ;;
      remove)
        systemctl --user disable --now telegram-mcp.service >/dev/null 2>&1 || true
        rm -f "$UNIT"
        systemctl --user daemon-reload
        echo "✓ Сервис остановлен и удалён"
        ;;
      restart)
        OLD_OWNER_PID="$(read_owner_pid || true)"
        systemctl --user restart telegram-mcp.service
        systemctl --user is-active --quiet telegram-mcp.service
        wait_for_owner_restart "$OLD_OWNER_PID"
        echo "✓ Служба перезапущена; новый владелец PID $(read_owner_pid) подтверждён"
        ;;
      status)
        systemctl --user status telegram-mcp.service --no-pager 2>/dev/null | head -12 || echo "Сервис не установлен"
        ;;
      *)
        echo "Использование: daemon-setup.sh [install|remove|restart|status]" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "✗ Неподдерживаемая ОС: $(uname -s)" >&2
    exit 1
    ;;
esac
