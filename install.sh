#!/usr/bin/env bash
# ============================================================================
#  Telegram MCP Starter — установщик для macOS и Linux
#
#  Подключает ваш ЛИЧНЫЙ Telegram-аккаунт к Claude (Desktop / Code / Cursor)
#  через MCP-сервер @overpod/mcp-telegram (MIT, open source).
#
#  Запуск одной командой:
#    bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.sh)
#
#  Что делает скрипт:
#    1. Проверяет Node.js 22+ (подсказывает, как установить, если нет)
#    2. Ставит закреплённую версию MCP-сервера в ~/.telegram-mcp/server
#    3. Спрашивает ваши api_id / api_hash (только у вас, хранит локально, 600)
#    4. Логин по QR-коду (поддерживает 2FA / облачный пароль)
#    5. Подключает сервер к Claude Code и/или Claude Desktop
#    6. (опционально) Настраивает фоновый сервис для нескольких агентов сразу
#    7. Проверяет, что всё работает (doctor)
#
#  Скрипт идемпотентный: можно запускать повторно, ничего не сломает.
# ============================================================================
set -euo pipefail
umask 077   # все создаваемые файлы (ключи, сессия) — только для владельца

PKG="@overpod/mcp-telegram"
PKG_VERSION="1.43.1"
SOURCE_VERSION="v2.0.0"
SOURCE_REPOSITORY="alexfisenkov/telegram-mcp-starter"

RUNTIME_ONLY=0
CUSTOM_INSTALL_ROOT=0
INSTALL_ROOT_ARGUMENT=0
SOURCE_ARCHIVE_OVERRIDE=""
SOURCE_COMMIT_OVERRIDE=""
BASE_DIR="${TELEGRAM_MCP_INSTALL_ROOT:-$HOME/.telegram-mcp}"
[[ -n "${TELEGRAM_MCP_INSTALL_ROOT:-}" ]] && CUSTOM_INSTALL_ROOT=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime-only) RUNTIME_ONLY=1; shift ;;
    --install-root)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Использование: install.sh [--runtime-only] [--install-root <путь>]" >&2; exit 2; }
      BASE_DIR="$2"; CUSTOM_INSTALL_ROOT=1; INSTALL_ROOT_ARGUMENT=1; shift 2 ;;
    --source-archive)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Укажите путь после --source-archive." >&2; exit 2; }
      SOURCE_ARCHIVE_OVERRIDE="$2"; shift 2 ;;
    --source-commit)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Укажите SHA после --source-commit." >&2; exit 2; }
      SOURCE_COMMIT_OVERRIDE="$2"; shift 2 ;;
    -h|--help)
      echo "Использование: install.sh [--runtime-only] [--install-root <путь>] [--source-archive <путь> --source-commit <40-hex-SHA>]"
      echo "--runtime-only устанавливает проверенный runtime без авторизации, конфигов клиентов и сервисов."
      exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done
if [[ "$CUSTOM_INSTALL_ROOT" -eq 1 && "$RUNTIME_ONLY" -ne 1 ]]; then
  echo "Пользовательский --install-root разрешён только вместе с --runtime-only." >&2
  exit 2
fi
if [[ -n "$SOURCE_ARCHIVE_OVERRIDE" || -n "$SOURCE_COMMIT_OVERRIDE" ]]; then
  if [[ "$RUNTIME_ONLY" -ne 1 || "$CUSTOM_INSTALL_ROOT" -ne 1 || "$INSTALL_ROOT_ARGUMENT" -ne 1 || -z "$SOURCE_ARCHIVE_OVERRIDE" || -z "$SOURCE_COMMIT_OVERRIDE" ]]; then
    echo "--source-archive и --source-commit разрешены только вместе с --runtime-only, --install-root и друг с другом." >&2
    exit 2
  fi
  if [[ ! "$SOURCE_COMMIT_OVERRIDE" =~ ^[a-fA-F0-9]{40}$ || ! -f "$SOURCE_ARCHIVE_OVERRIDE" ]]; then
    echo "Для тестового источника нужен существующий архив и полный 40-символьный commit SHA." >&2
    exit 2
  fi
fi

SERVER_DIR="$BASE_DIR/server"
ENV_FILE="$BASE_DIR/telegram.env"
SESSION_PATH="$BASE_DIR/session"
WRAPPER="$BASE_DIR/run.sh"
DOCTOR="$SERVER_DIR/doctor.mjs"
MERGER="$SERVER_DIR/merge-config.mjs"
CLI_JS="$SERVER_DIR/node_modules/@overpod/mcp-telegram/dist/cli.js"

# ---------- оформление ------------------------------------------------------
if [[ -t 1 ]]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_OFF=""
fi
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
step() { printf '\n%s%s==> %s%s\n' "$C_BOLD" "$C_BLUE" "$*" "$C_OFF"; }

ask_yn() { # ask_yn "вопрос" -> 0=yes 1=no
  local answer
  while true; do
    if ! read -r -p "$1 [y/n]: " answer </dev/tty; then
      err "Не удалось прочитать ответ — запускайте установщик в обычном интерактивном терминале."
      exit 1
    fi
    case "$answer" in
      [YyДд]*) return 0 ;;
      [NnНн]*) return 1 ;;
      *) echo "Введите y (да) или n (нет)." ;;
    esac
  done
}

printf '%s\n' \
  "" \
  "${C_BOLD}Telegram MCP Starter${C_OFF} — подключаем ваш Telegram к Claude" \
  "Сервер: $PKG@$PKG_VERSION · исходники $SOURCE_VERSION · установка в: $BASE_DIR" \
  ""

# ---------- шаг 1: Node.js --------------------------------------------------
step "Шаг 1/7 · Проверяю Node.js"

print_node_manual_help() {
  echo ""
  echo "Установите Node.js LTS (22 или новее) вручную и запустите скрипт ещё раз:"
  case "$(uname -s)" in
    Darwin)
      echo "  • Вариант 1: скачайте установщик с https://nodejs.org (кнопка LTS)"
      echo "  • Вариант 2 (если есть Homebrew): brew install node"
      ;;
    Linux)
      echo "  • Универсально (без sudo): установите nvm — https://github.com/nvm-sh/nvm"
      echo "  • Ubuntu/Debian:  sudo apt update && sudo apt install -y nodejs npm"
      echo "  • Fedora:         sudo dnf install -y nodejs"
      ;;
  esac
}

install_node_auto() { # автоматическая установка Node.js LTS на чистый компьютер
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        if ask_yn "Установить Node.js автоматически через Homebrew?"; then
          brew install node && return 0
        fi
        return 1
      fi
      if ask_yn "Установить Node.js LTS автоматически? (скачаю официальный установщик nodejs.org, система спросит пароль администратора)"; then
        local pkg_name pkg_url tmp_pkg
        # имя свежего LTS-пакета берём из официального каталога nodejs.org
        # (.pkg универсальный — подходит и Apple Silicon, и Intel)
        pkg_name="$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/" | grep -oE 'node-v22[0-9.]+\.pkg' | head -1)"
        if [[ -z "$pkg_name" ]]; then
          err "Не удалось определить свежую версию Node.js — установите вручную."
          return 1
        fi
        pkg_url="https://nodejs.org/dist/latest-v22.x/$pkg_name"
        tmp_pkg="$(mktemp -d)/$pkg_name"
        echo "Скачиваю $pkg_url ..."
        curl -fL -o "$tmp_pkg" "$pkg_url"
        echo "Устанавливаю (потребуется пароль администратора)..."
        sudo installer -pkg "$tmp_pkg" -target / || return 1
        rm -f "$tmp_pkg"
        export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
        return 0
      fi
      return 1
      ;;
    Linux)
      if ask_yn "Установить Node.js LTS автоматически через nvm? (в вашу домашнюю папку, без прав администратора)"; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        # shellcheck source=/dev/null
        [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
        nvm install --lts && return 0
      fi
      return 1
      ;;
  esac
  return 1
}

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  if [[ "$RUNTIME_ONLY" -eq 1 ]]; then
    err "Режим --runtime-only не устанавливает системные зависимости. Сначала установите Node.js 22+ и запустите команду повторно."
    exit 1
  fi
  warn "Node.js не найден — попробую установить автоматически."
  if install_node_auto; then
    hash -r 2>/dev/null || true
    NODE_BIN="$(command -v node || true)"
  fi
  if [[ -z "$NODE_BIN" ]]; then
    err "Node.js так и не установлен."
    print_node_manual_help
    exit 1
  fi
  ok "Node.js установлен автоматически"
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  err "Найден Node.js $("$NODE_BIN" -v), а нужен 22 или новее."
  echo "Обновите Node.js с https://nodejs.org (кнопка LTS) и запустите скрипт ещё раз."
  exit 1
fi
ok "Node.js $("$NODE_BIN" -v) — подходит ($NODE_BIN)"

NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  err "npm не найден (обычно ставится вместе с Node.js). Переустановите Node.js с https://nodejs.org"
  exit 1
fi
ok "npm $(npm -v)"

# ---------- шаг 2: установка проверенного публичного runtime ----------------
step "Шаг 2/7 · Устанавливаю $PKG@$PKG_VERSION и runtime $SOURCE_VERSION"

mkdir -p "$BASE_DIR"
chmod 700 "$BASE_DIR"
STAGE_ROOT="$(mktemp -d "$BASE_DIR/.telegram-mcp-stage.XXXXXX")"
STAGED_SERVER="$STAGE_ROOT/server"
BACKUP_DIR=""
cleanup_stage() {
  local status=$?
  trap - EXIT
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" && ! -e "$SERVER_DIR" ]]; then
    mv "$BACKUP_DIR" "$SERVER_DIR" || status=$?
  fi
  if [[ -n "$STAGE_ROOT" && -d "$STAGE_ROOT" ]]; then
    rm -rf "$STAGE_ROOT" || status=$?
  fi
  return "$status"
}
trap cleanup_stage EXIT
mkdir -p "$STAGED_SERVER"
if [[ -n "$SOURCE_ARCHIVE_OVERRIDE" ]]; then
  SOURCE_COMMIT="$(printf "%s" "$SOURCE_COMMIT_OVERRIDE" | tr "[:upper:]" "[:lower:]")"
  SOURCE_ARCHIVE="$SOURCE_ARCHIVE_OVERRIDE"
else
  curl -fsSL --retry 3 --retry-delay 1 "https://api.github.com/repos/$SOURCE_REPOSITORY/commits/$SOURCE_VERSION" -o "$STAGE_ROOT/release.json"
  SOURCE_COMMIT="$("$NODE_BIN" -p 'require(process.argv[1]).sha' "$STAGE_ROOT/release.json")"
  if [[ ! "$SOURCE_COMMIT" =~ ^[a-fA-F0-9]{40}$ ]]; then
    err "GitHub API не вернул полный commit SHA для $SOURCE_VERSION."
    exit 1
  fi
  SOURCE_COMMIT="$(printf "%s" "$SOURCE_COMMIT" | tr "[:upper:]" "[:lower:]")"
  SOURCE_ARCHIVE="$STAGE_ROOT/source.tar.gz"
  curl -fL --retry 3 --retry-delay 1 "https://github.com/$SOURCE_REPOSITORY/archive/$SOURCE_COMMIT.tar.gz" -o "$SOURCE_ARCHIVE"
fi
tar -xzf "$SOURCE_ARCHIVE" --strip-components=1 -C "$STAGED_SERVER"
[[ -f "$STAGED_SERVER/package.json" && -f "$STAGED_SERVER/package-lock.json" && -f "$STAGED_SERVER/runtime/manifest.json" ]] || {
  err "Архив $SOURCE_VERSION неполный: отсутствуют package.json, lockfile или runtime manifest."
  exit 1
}
SOURCE_PACKAGE_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "$STAGED_SERVER/package.json")"
[[ "$SOURCE_PACKAGE_VERSION" == "2.0.0" ]] || { err "Ожидалась версия исходников 2.0.0, получена $SOURCE_PACKAGE_VERSION."; exit 1; }
TELEPROTO_OVERRIDE="$("$NODE_BIN" -e 'const p=require(process.argv[1]); process.stdout.write(p.overrides?.telegram || "")' "$STAGED_SERVER/package.json")"
[[ "$TELEPROTO_OVERRIDE" == "npm:teleproto@1.229.0" ]] || { err "Исходники должны закреплять override telegram: npm:teleproto@1.229.0."; exit 1; }
LOCKED_PACKAGE_VERSION="$("$NODE_BIN" -e 'const p=require(process.argv[1]); process.stdout.write(p.packages?.["node_modules/@overpod/mcp-telegram"]?.version || "")' "$STAGED_SERVER/package-lock.json")"
[[ "$LOCKED_PACKAGE_VERSION" == "$PKG_VERSION" ]] || { err "Lockfile закрепляет $PKG@$LOCKED_PACKAGE_VERSION, ожидалась $PKG_VERSION."; exit 1; }
LOCKED_TELEPROTO_VERSION="$("$NODE_BIN" -e 'const p=require(process.argv[1]); process.stdout.write(p.packages?.["node_modules/@overpod/mcp-telegram/node_modules/telegram"]?.version || "")' "$STAGED_SERVER/package-lock.json")"
[[ "$LOCKED_TELEPROTO_VERSION" == "1.229.0" ]] || { err "Lockfile не закрепляет teleproto@1.229.0 (получено $LOCKED_TELEPROTO_VERSION)."; exit 1; }
LOCKED_PLAYWRIGHT_VERSION="$("$NODE_BIN" -e 'const p=require(process.argv[1]); process.stdout.write(p.packages?.["node_modules/playwright"]?.version || "")' "$STAGED_SERVER/package-lock.json")"
[[ "$LOCKED_PLAYWRIGHT_VERSION" == "1.62.1" ]] || { err "Lockfile не закрепляет Playwright@1.62.1 (получено $LOCKED_PLAYWRIGHT_VERSION)."; exit 1; }
(cd "$STAGED_SERVER" && "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund --loglevel=error)
"$NODE_BIN" "$STAGED_SERVER/tools/apply-patches.mjs" --package-dir "$STAGED_SERVER/node_modules/@overpod/mcp-telegram"
"$NODE_BIN" "$STAGED_SERVER/tools/apply-patches.mjs" --package-dir "$STAGED_SERVER/node_modules/@overpod/mcp-telegram" --check
[[ -f "$STAGED_SERVER/node_modules/@overpod/mcp-telegram/dist/cli.js" ]] || { err "Runtime CLI не найден после проверки."; exit 1; }
printf '%s\n' 'import "./tools/doctor.mjs";' > "$STAGED_SERVER/doctor.mjs"
printf '%s\n' 'import "./tools/merge-config.mjs";' > "$STAGED_SERVER/merge-config.mjs"
cat > "$STAGED_SERVER/runtime/source-receipt.json" <<EOF
{
  "repository": "$SOURCE_REPOSITORY",
  "version": "$SOURCE_VERSION",
  "commitSHA": "$SOURCE_COMMIT"
}
EOF

if [[ -e "$SERVER_DIR" ]]; then
  BACKUP_DIR="$BASE_DIR/server.backup-$(date -u '+%Y%m%dT%H%M%SZ')"
  [[ ! -e "$BACKUP_DIR" ]] || { err "Каталог резервной копии уже существует: $BACKUP_DIR"; exit 1; }
  mv "$SERVER_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGED_SERVER" "$SERVER_DIR"; then
  err "Не удалось активировать новый runtime; восстанавливаю предыдущую версию."
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then mv "$BACKUP_DIR" "$SERVER_DIR"; BACKUP_DIR=""; fi
  exit 1
fi
ok "Runtime $SOURCE_VERSION активирован: $SERVER_DIR"
if [[ -n "$BACKUP_DIR" ]]; then ok "Предыдущая версия сохранена: $BACKUP_DIR"; fi
BACKUP_DIR=""
rm -rf "$STAGE_ROOT"
STAGE_ROOT=""
trap - EXIT

if [[ "$RUNTIME_ONLY" -eq 1 ]]; then
  ok "Runtime установлен. Режим --runtime-only не запрашивал ключи, не входил в Telegram и не менял конфиги клиентов или службы."
  exit 0
fi

# ---------- шаг 3: api_id / api_hash ----------------------------------------
step "Шаг 3/7 · Ключи Telegram API (api_id / api_hash)"

echo "Ключи берутся на https://my.telegram.org → API development tools."
echo "Подробная инструкция: docs/01-api-keys.md в репозитории."
echo "Ключи сохраняются ТОЛЬКО на этом компьютере: $ENV_FILE (права 600)."
echo ""

WRITE_ENV=1
if [[ -f "$ENV_FILE" ]]; then
  ok "Файл с ключами уже существует: $ENV_FILE"
  if ask_yn "Оставить текущие ключи?"; then
    WRITE_ENV=0
  fi
fi

if [[ "$WRITE_ENV" -eq 1 ]]; then
  while true; do
    read -r -p "TELEGRAM_API_ID (только цифры): " TG_API_ID </dev/tty \
      || { err "Не удалось прочитать ввод — запускайте установщик в интерактивном терминале."; exit 1; }
    [[ "$TG_API_ID" =~ ^[0-9]+$ ]] && break
    warn "api_id — это число, например 1234567. Попробуйте ещё раз."
  done
  while true; do
    read -r -s -p "TELEGRAM_API_HASH (32 символа, ввод скрыт): " TG_API_HASH </dev/tty \
      || { err "Не удалось прочитать ввод — запускайте установщик в интерактивном терминале."; exit 1; }
    printf '\n'
    [[ "$TG_API_HASH" =~ ^[a-fA-F0-9]{32}$ ]] && break
    warn "api_hash — 32 шестнадцатеричных символа (буквы a-f и цифры). Попробуйте ещё раз."
  done

  cat > "$ENV_FILE" <<EOF
TELEGRAM_API_ID=$TG_API_ID
TELEGRAM_API_HASH=$TG_API_HASH
EOF
  chmod 600 "$ENV_FILE"
  ok "Ключи сохранены в $ENV_FILE"
fi

# ---------- служебные файлы (wrapper, doctor, merger) -----------------------
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Обёртка запуска Telegram MCP: секреты живут в telegram.env, а не в конфигах клиентов.
set -euo pipefail
ENV_FILE="\$HOME/.telegram-mcp/telegram.env"
NODE_BIN="$NODE_BIN"
if [[ ! -x "\$NODE_BIN" ]]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"
  NODE_BIN="\$(command -v node || true)"
fi
if [[ -z "\$NODE_BIN" ]]; then
  # node мог быть установлен через nvm — берём самую свежую версию
  for cand in "\$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "\$cand" ]] && NODE_BIN="\$cand"
  done
fi
if [[ -z "\$NODE_BIN" ]]; then
  echo "telegram-mcp: node не найден — переустановите Node.js и запустите install.sh снова" >&2
  exit 127
fi
if [[ ! -f "\$ENV_FILE" ]]; then
  echo "telegram-mcp: нет файла \$ENV_FILE — запустите install.sh снова" >&2
  exit 78
fi
if [[ "\${TELEGRAM_MCP_NO_AUTH:-0}" != "1" ]]; then
  set -a
  source "\$ENV_FILE"
  set +a
fi
export TELEGRAM_SESSION_PATH="\${TELEGRAM_SESSION_PATH:-\$HOME/.telegram-mcp/session}"
exec "\$NODE_BIN" "\$HOME/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/cli.js" "\$@"
EOF
chmod 700 "$WRAPPER"

# Файлы doctor/merge-config и daemon-setup уже входят в закреплённый архив.
cp "$SERVER_DIR/tools/daemon-setup.sh" "$BASE_DIR/daemon-setup.sh"
chmod 700 "$BASE_DIR/daemon-setup.sh"
DAEMON_SETUP="$BASE_DIR/daemon-setup.sh"

# ---------- шаг 4: вход по QR-коду ------------------------------------------
step "Шаг 4/7 · Вход в Telegram по QR-коду"

DO_LOGIN=1
if [[ -f "$SESSION_PATH" ]]; then
  ok "Файл сессии уже существует — вероятно, вы уже входили."
  if ! ask_yn "Войти заново? (обычно НЕ нужно)"; then
    DO_LOGIN=0
  fi
fi

if [[ "$DO_LOGIN" -eq 1 ]]; then
  echo ""
  if ask_yn "Включён ли у вас облачный пароль (2FA) в Telegram? (Настройки → Конфиденциальность → Облачный пароль)"; then
    read -r -s -p "Введите облачный пароль (ввод скрыт, нигде не сохраняется): " TG_2FA </dev/tty \
      || { err "Не удалось прочитать ввод."; exit 1; }
    printf '\n'
    export TELEGRAM_2FA_PASSWORD="$TG_2FA"
    unset TG_2FA
  fi
  echo ""
  echo "Сейчас в терминале появится QR-код. На телефоне откройте Telegram:"
  echo "  Настройки → Устройства → Подключить устройство — и отсканируйте код."
  echo ""
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  export TELEGRAM_SESSION_PATH="${TELEGRAM_SESSION_PATH:-$SESSION_PATH}"
  if ! "$NODE_BIN" "$CLI_JS" login </dev/tty; then
    unset TELEGRAM_2FA_PASSWORD 2>/dev/null || true
    err "Вход не удался. Посмотрите docs/TROUBLESHOOTING.md и запустите установщик снова."
    exit 1
  fi
  unset TELEGRAM_2FA_PASSWORD 2>/dev/null || true
  ok "Вход выполнен, сессия сохранена: $TELEGRAM_SESSION_PATH"

fi

# Restart only the known managed service, then prove a new session owner is alive.
MANAGED_DAEMON=0
case "$(uname -s)" in
  Darwin) [[ -f "$HOME/Library/LaunchAgents/com.telegram-mcp.daemon.plist" ]] && MANAGED_DAEMON=1 ;;
  Linux) [[ -f "$HOME/.config/systemd/user/telegram-mcp.service" ]] && MANAGED_DAEMON=1 ;;
esac
if [[ "$MANAGED_DAEMON" -eq 1 ]]; then
  if ! "$DAEMON_SETUP" restart; then
    err "Runtime обновлён, но владелец службы не подтвердил запуск новой версии. Не подключайте клиентов: проверьте службу, остановите старые MCP-клиенты и повторите установку."
    exit 1
  fi
  ok "Управляемая служба перезапущена с сохранённой сессией."
fi

# ---------- шаг 5: подключение к клиентам -----------------------------------
step "Шаг 5/7 · Подключаю к Claude"

# Claude Code (CLI)
if command -v claude >/dev/null 2>&1; then
  if ask_yn "Найден Claude Code. Подключить Telegram к Claude Code?"; then
    claude mcp remove telegram -s user >/dev/null 2>&1 || true
    if claude mcp add telegram -s user -- "$WRAPPER"; then
      ok "Готово. Проверка внутри Claude Code: наберите /mcp"
    else
      warn "Не удалось подключить к Claude Code автоматически — см. docs/06-claude-code.md"
    fi
  fi
else
  warn "Claude Code (команда claude) не найден — пропускаю. Инструкция: docs/06-claude-code.md"
fi

# Claude Desktop
case "$(uname -s)" in
  Darwin) DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *)      DESKTOP_CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac

if [[ -d "$(dirname "$DESKTOP_CFG")" || -f "$DESKTOP_CFG" ]]; then
  if ask_yn "Найден Claude Desktop. Добавить Telegram в его конфиг (с резервной копией)?"; then
    if "$NODE_BIN" "$MERGER" "$DESKTOP_CFG" "$WRAPPER"; then
      warn "Полностью перезапустите Claude Desktop (Cmd+Q / выйти и открыть заново)."
    else
      warn "Не удалось изменить конфиг автоматически — настройте вручную по docs/05-claude-desktop.md"
    fi
  fi
else
  warn "Claude Desktop не найден — пропускаю. Инструкция: docs/05-claude-desktop.md"
fi

# ---------- шаг 6: несколько агентов (опционально) ---------------------------
step "Шаг 6/7 · Несколько AI-агентов одновременно (опционально)"

echo "Если вы работаете с НЕСКОЛЬКИМИ AI-агентами сразу (Claude Code + Claude"
echo "Desktop + Codex + Cursor...), рекомендуется фоновый сервис: он постоянно"
echo "владеет соединением с Telegram, агенты подключаются к нему как клиенты,"
echo "и закрытие любого агента не отключает Telegram у остальных."
echo "Настроить можно и позже: ~/.telegram-mcp/daemon-setup.sh install"
echo ""
if [[ "$MANAGED_DAEMON" -eq 1 ]]; then
  ok "Управляемая служба уже настроена и перезапущена."
elif ask_yn "Настроить фоновый сервис сейчас?"; then
  if "$DAEMON_SETUP" install; then
    ok "Фоновый сервис установлен; подтвержу подключение в следующем шаге."
  else
    warn "Не удалось настроить сервис — см. docs/08-multi-agent.md"
  fi
fi

# ---------- шаг 7: проверка ---------------------------------------------------
step "Шаг 7/7 · Проверяю подключение (doctor)"

if "$NODE_BIN" "$DOCTOR" --status "$WRAPPER"; then
  ok "Runtime, каталог инструментов и авторизованное подключение подтверждены."
else
  err "Runtime установлен, но подключение или каталог актуального owner не подтверждены. Закройте/перезапустите службу или MCP-клиенты, затем повторите: $NODE_BIN $DOCTOR --status $WRAPPER"
  exit 1
fi

# ---------- итог --------------------------------------------------------------
printf '\n%s%s================= ГОТОВО =================%s\n' "$C_BOLD" "$C_GREEN" "$C_OFF"
cat <<SUMMARY

Что установлено:
  • Сервер:        $SERVER_DIR  ($PKG@$PKG_VERSION)
  • Ключи API:     $ENV_FILE  (права 600 — только ваш пользователь)
  • Сессия:        $SESSION_PATH
  • Запуск:        $WRAPPER
  • Проверка:      "$NODE_BIN" "$DOCTOR" "$WRAPPER"
  • Фоновый сервис (несколько агентов): $DAEMON_SETUP [install|remove|restart|status]

Первые команды для Claude (просто напишите в чат):
  • «Покажи мои непрочитанные сообщения в Telegram»
  • «Найди в Telegram чат с <имя> и покажи последние 10 сообщений»
  • «Отправь сообщение <кому>: <текст>» (Claude покажет, что собирается отправить)

Безопасность (обязательно прочитайте docs/SECURITY.md):
  • Файлы $ENV_FILE и $SESSION_PATH никому не передавайте —
    это полный доступ к вашему аккаунту.
  • Проверить/отозвать сессию можно в Telegram: Настройки → Устройства.

SUMMARY
