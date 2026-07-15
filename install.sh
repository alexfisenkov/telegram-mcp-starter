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
#    1. Проверяет Node.js 18+ (подсказывает, как установить, если нет)
#    2. Ставит закреплённую версию MCP-сервера в ~/.telegram-mcp/server
#    3. Спрашивает ваши api_id / api_hash (только у вас, хранит локально, 600)
#    4. Логин по QR-коду (поддерживает 2FA / облачный пароль)
#    5. Подключает сервер к Claude Code и/или Claude Desktop
#    6. Проверяет, что всё работает (doctor)
#
#  Скрипт идемпотентный: можно запускать повторно, ничего не сломает.
# ============================================================================
set -euo pipefail
umask 077   # все создаваемые файлы (ключи, сессия) — только для владельца

PKG="@overpod/mcp-telegram"
PKG_VERSION="1.41.2"

BASE_DIR="$HOME/.telegram-mcp"
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
  "Сервер: $PKG@$PKG_VERSION · Установка в: $BASE_DIR" \
  ""

# ---------- шаг 1: Node.js --------------------------------------------------
step "Шаг 1/6 · Проверяю Node.js"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  err "Node.js не найден."
  echo ""
  echo "Установите Node.js LTS (18 или новее) и запустите скрипт ещё раз:"
  case "$(uname -s)" in
    Darwin)
      echo "  • Вариант 1 (рекомендую): скачайте установщик с https://nodejs.org (кнопка LTS)"
      echo "  • Вариант 2 (если есть Homebrew): brew install node"
      ;;
    Linux)
      echo "  • Ubuntu/Debian:  sudo apt update && sudo apt install -y nodejs npm"
      echo "    (если в репозитории старая версия — https://nodejs.org/en/download)"
      echo "  • Fedora:         sudo dnf install -y nodejs"
      echo "  • Универсально:   установите nvm — https://github.com/nvm-sh/nvm"
      ;;
  esac
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  err "Найден Node.js $("$NODE_BIN" -v), а нужен 18 или новее."
  echo "Обновите Node.js с https://nodejs.org (кнопка LTS) и запустите скрипт ещё раз."
  exit 1
fi
ok "Node.js $("$NODE_BIN" -v) — подходит ($NODE_BIN)"

if ! command -v npm >/dev/null 2>&1; then
  err "npm не найден (обычно ставится вместе с Node.js). Переустановите Node.js с https://nodejs.org"
  exit 1
fi
ok "npm $(npm -v)"

# ---------- шаг 2: установка сервера ----------------------------------------
step "Шаг 2/6 · Устанавливаю MCP-сервер $PKG@$PKG_VERSION"

mkdir -p "$BASE_DIR" "$SERVER_DIR"
chmod 700 "$BASE_DIR"

if [[ ! -f "$SERVER_DIR/package.json" ]]; then
  printf '{\n  "name": "telegram-mcp-local",\n  "private": true\n}\n' > "$SERVER_DIR/package.json"
fi

npm install --prefix "$SERVER_DIR" "$PKG@$PKG_VERSION" --no-fund --no-audit --loglevel=error
if [[ ! -f "$CLI_JS" ]]; then
  err "Установка не удалась: не найден $CLI_JS"
  exit 1
fi
ok "Сервер установлен: $SERVER_DIR"

# ---------- шаг 3: api_id / api_hash ----------------------------------------
step "Шаг 3/6 · Ключи Telegram API (api_id / api_hash)"

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
set -a
source "\$ENV_FILE"
set +a
export TELEGRAM_SESSION_PATH="\${TELEGRAM_SESSION_PATH:-\$HOME/.telegram-mcp/session}"
exec "\$NODE_BIN" "\$HOME/.telegram-mcp/server/node_modules/@overpod/mcp-telegram/dist/cli.js" "\$@"
EOF
chmod 700 "$WRAPPER"

cat > "$DOCTOR" <<'EOF'
#!/usr/bin/env node
// Доктор: подключается к Telegram MCP как настоящий клиент и вызывает telegram-status.
// Использование: node doctor.mjs <команда-сервера> [аргументы...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Использование: node doctor.mjs <команда-сервера> [аргументы...]");
  process.exit(2);
}

const transport = new StdioClientTransport({ command, args, env: { ...process.env } });
const client = new Client({ name: "telegram-mcp-doctor", version: "1.0.0" });
const timer = setTimeout(() => {
  console.error("✗ Сервер не ответил за 90 секунд. Проверьте интернет и docs/TROUBLESHOOTING.md");
  process.exit(1);
}, 90000);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`✓ MCP-сервер запустился, инструментов доступно: ${tools.tools.length}`);
  const status = await client.callTool({ name: "telegram-status", arguments: {} });
  const text = (status.content ?? []).map((i) => i.text ?? "").join("\n").trim();
  console.log(text);
  if (status.isError) {
    console.error("! Инструмент telegram-status вернул ошибку — см. текст выше.");
    process.exitCode = 1;
  }
  if (/not\s+(logged|connected|authorized)/i.test(text)) {
    console.error("! Похоже, вы ещё не вошли в аккаунт — выполните вход по QR-коду (login).");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`✗ Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}
EOF

cat > "$MERGER" <<'EOF'
#!/usr/bin/env node
// Безопасно добавляет (или удаляет) сервер "telegram" в JSON-конфиг MCP-клиента.
// Перед изменением делает резервную копию рядом с конфигом.
// Использование:
//   node merge-config.mjs <config.json> <command> [args...]   — добавить/обновить
//   node merge-config.mjs <config.json> --remove              — удалить
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const [configPath, command, ...args] = process.argv.slice(2);
if (!configPath || !command) {
  console.error("Использование: node merge-config.mjs <config.json> <command|--remove> [args...]");
  process.exit(2);
}

let config = {};
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(configPath, `${configPath}.backup-${stamp}`);
  if (raw.trim() !== "") {
    try {
      config = JSON.parse(raw);
    } catch {
      console.error(`✗ Файл повреждён (невалидный JSON): ${configPath}. Исправьте его вручную.`);
      process.exit(1);
    }
  }
} else {
  mkdirSync(dirname(configPath), { recursive: true });
}

config.mcpServers = config.mcpServers ?? {};
if (command === "--remove") {
  delete config.mcpServers.telegram;
  console.log(`✓ Сервер "telegram" удалён из ${configPath}`);
} else {
  config.mcpServers.telegram = args.length > 0 ? { command, args } : { command };
  console.log(`✓ Сервер "telegram" добавлен в ${configPath}`);
}
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
EOF

ok "Служебные скрипты записаны (run.sh, doctor.mjs, merge-config.mjs)"

# ---------- шаг 4: вход по QR-коду ------------------------------------------
step "Шаг 4/6 · Вход в Telegram по QR-коду"

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

# ---------- шаг 5: подключение к клиентам -----------------------------------
step "Шаг 5/6 · Подключаю к Claude"

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

# ---------- шаг 6: проверка ---------------------------------------------------
step "Шаг 6/6 · Проверяю подключение (doctor)"

if "$NODE_BIN" "$DOCTOR" "$WRAPPER"; then
  ok "Всё работает!"
else
  warn "Проверка не прошла. Загляните в docs/TROUBLESHOOTING.md — там разобраны типовые ошибки."
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

Первые команды для Claude (просто напишите в чат):
  • «Покажи мои непрочитанные сообщения в Telegram»
  • «Найди в Telegram чат с <имя> и покажи последние 10 сообщений»
  • «Отправь сообщение <кому>: <текст>» (Claude покажет, что собирается отправить)

Безопасность (обязательно прочитайте docs/SECURITY.md):
  • Файлы $ENV_FILE и $SESSION_PATH никому не передавайте —
    это полный доступ к вашему аккаунту.
  • Проверить/отозвать сессию можно в Telegram: Настройки → Устройства.

SUMMARY
