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

if [[ ! -x "$RUN" ]]; then
  echo "✗ Нет $RUN — сначала запустите install.sh" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    LABEL="com.telegram-mcp.daemon"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    DOMAIN="gui/$(id -u)"
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
    <string>$RUN</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
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
        launchctl kickstart -k "$DOMAIN/$LABEL" && echo "✓ Сервис перезапущен"
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
    case "$CMD" in
      install)
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Telegram MCP daemon (connection owner)

[Service]
ExecStart=$RUN serve
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
        systemctl --user restart telegram-mcp.service && echo "✓ Сервис перезапущен"
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
