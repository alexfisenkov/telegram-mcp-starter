# Установка на Linux — пошагово

Проверено на Ubuntu/Debian; для других дистрибутивов отличается только установка Node.js.

## Шаг 1. Установите Node.js 18+ (если ещё нет)

> **Совсем чистый компьютер?** Можно пропустить этот шаг: установщик сам предложит поставить Node.js автоматически через nvm (в домашнюю папку, без sudo).

```bash
node -v
```

Если версии нет или она ниже 18:

**Ubuntu / Debian:**

```bash
sudo apt update && sudo apt install -y nodejs npm
node -v   # если в репозитории оказалась версия < 18 — используйте nvm (ниже)
```

**Fedora:**

```bash
sudo dnf install -y nodejs
```

**Универсальный способ (любой дистрибутив, без sudo) — nvm:**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# закройте и откройте терминал заново, затем:
nvm install --lts
```

## Шаг 2. Получите api_id и api_hash

Если ещё не получили — [инструкция на 5 минут](01-api-keys.md).

## Шаг 3. Запустите установщик

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.sh)
```

Шаги те же, что на macOS (см. [02-macos.md](02-macos.md), шаг 3): проверка Node → установка сервера в `~/.telegram-mcp/server` → ввод ключей → вопрос про облачный пароль (2FA — вводится до показа QR) → **QR-код в терминале** (Telegram → Настройки → Устройства → Подключить устройство) → подключение к Claude → автопроверка.

## Шаг 4. Клиенты

- **Claude Code:** установщик подключит сам (если команда `claude` доступна). Проверка: `/mcp` в новой сессии.
- **Claude Desktop for Linux:** если установлен, конфиг лежит в `~/.config/Claude/claude_desktop_config.json` — установщик предложит добавить запись автоматически. Вручную: [05-claude-desktop.md](05-claude-desktop.md).
- **Другие клиенты (Cursor, VS Code и т.п.):** [ADVANCED.md](ADVANCED.md#другие-mcp-клиенты).

## Шаг 5. Проверьте

Напишите Claude: **«Выполни telegram-status»** — в ответ придёт имя вашего аккаунта.

Самодиагностика:

```bash
node ~/.telegram-mcp/server/doctor.mjs ~/.telegram-mcp/run.sh
```

## Особенности Linux / VPS

- **Сервер без монитора (headless):** QR-код рисуется прямо в текстовом терминале — сканируется даже по SSH.
- **Провайдер блокирует Telegram:** см. [ADVANCED.md](ADVANCED.md#прокси-socks5--mtproxy) — поддерживаются SOCKS5-прокси и MTProxy.
- **Хостинг режет порт 80 к серверам Telegram:** добавьте `TELEGRAM_USE_WSS=true` в `~/.telegram-mcp/telegram.env` — соединение пойдёт через порт 443.

Проблемы: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
