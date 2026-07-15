# Telegram MCP Starter — подключи свой Telegram к Claude

**Полный набор для подключения ЛИЧНОГО Telegram-аккаунта к Claude (Desktop, Code, Cursor и любому MCP-клиенту).** Установка одной командой, вход по QR-коду, ~170 инструментов: чтение и отправка сообщений, поиск по всем чатам, реакции, файлы, опросы, папки, истории и многое другое.

После установки вы сможете просто писать Claude:

> «Покажи непрочитанные сообщения» · «Найди, что мне писал Иван про оплату» · «Ответь маме, что перезвоню вечером» · «Сделай сводку канала за неделю»

— и Claude сделает это в **вашем** Telegram от **вашего** имени.

Под капотом — открытый MCP-сервер [`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) (MIT), работающий по протоколу MTProto (как обычное приложение Telegram, а не как бот). Этот репозиторий добавляет к нему: русские инструкции для новичков, установщики под все ОС, безопасное хранение ключей и скрипт проверки.

---

## ⚠️ Прочитайте до установки

1. **Это доступ к вашему ЛИЧНОМУ аккаунту.** Claude сможет читать и отправлять сообщения от вашего имени. Подключайте только СВОЙ аккаунт и только на СВОЁМ компьютере.
2. **Два файла = ключи от аккаунта.** После установки на компьютере появятся `telegram.env` (ключи API) и `session` (сессия входа). Тот, у кого есть эти файлы, получает полный доступ к вашему Telegram. **Никому не отправляйте их, не показывайте на скриншотах, не кладите в облако.** Подробно: [docs/SECURITY.md](docs/SECURITY.md).
3. **Не спамьте.** Массовые рассылки незнакомым людям через автоматизацию — прямой путь к блокировке аккаунта Telegram. Используйте для своих чатов и задач.
4. Устанавливая, вы действуете на свой страх и риск и соглашаетесь с [условиями Telegram API](https://core.telegram.org/api/terms).

---

## Что понадобится (15–20 минут)

| # | Что | Где взять |
|---|-----|-----------|
| 1 | Компьютер: macOS, Windows 10/11 или Linux | у вас уже есть |
| 2 | **Node.js 18+** (рекомендую LTS) | [nodejs.org](https://nodejs.org) — кнопка LTS |
| 3 | **api_id и api_hash** — ваши личные ключи Telegram API | [my.telegram.org](https://my.telegram.org) — [пошаговая инструкция](docs/01-api-keys.md) |
| 4 | Телефон с Telegram под рукой | для сканирования QR-кода |
| 5 | Claude Desktop и/или Claude Code (достаточно одного) | Desktop: [claude.ai/download](https://claude.ai/download) · Code: [инструкция по установке](https://docs.anthropic.com/en/docs/claude-code/setup) |

---

## Быстрая установка (одна команда)

Сначала получите api_id/api_hash: **[docs/01-api-keys.md](docs/01-api-keys.md)** — 5 минут.

### macOS / Linux

Откройте Терминал и выполните:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.sh)
```

### Windows

Откройте PowerShell (Пуск → введите «PowerShell») и выполните:

```powershell
irm https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.ps1 | iex
```

> Если Windows ругается на запуск скриптов, сначала выполните:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

Установщик сам: проверит Node.js → поставит сервер → спросит ключи → покажет QR-код для входа (поддерживает 2FA) → подключит к Claude → проверит, что всё работает. На каждый вопрос отвечайте `y` (да) или `n` (нет).

**Пошаговые инструкции со всеми подробностями:**
[macOS](docs/02-macos.md) · [Windows](docs/03-windows.md) · [Linux](docs/04-linux.md) · [Claude Desktop](docs/05-claude-desktop.md) · [Claude Code](docs/06-claude-code.md) · [Проверка](docs/07-verify.md)

---

## Проверка после установки

1. Полностью перезапустите Claude Desktop (или откройте новую сессию Claude Code).
2. Напишите Claude: **«Выполни telegram-status»**.
3. В ответ должно прийти имя вашего аккаунта. Готово! 🎉

Диагностика в любой момент:

```bash
# macOS / Linux
node ~/.telegram-mcp/server/doctor.mjs ~/.telegram-mcp/run.sh
```

```powershell
# Windows
node "$env:USERPROFILE\.telegram-mcp\server\doctor.mjs" cmd /c "$env:USERPROFILE\.telegram-mcp\run.cmd"
```

---

## Что умеет (кратко)

Полный список инструментов по категориям (168 включены по умолчанию, 181 со всеми опциональными): **[docs/TOOLS.md](docs/TOOLS.md)**.

- **Сообщения** — читать, отправлять, редактировать, пересылать, отвечать цитатой, отложенные
- **Поиск** — по чату, по всем чатам сразу, поиск чатов и людей
- **Медиа** — отправка и скачивание файлов, фото, голосовых, видеокружков, альбомов
- **Чаты и группы** — создание, приглашения, права, папки, закрепы, архив, отключение уведомлений (mute)
- **Реакции, опросы, стикеры, темы форумов, истории, черновики**
- **Каналы** — статистика, комментарии, заявки на вступление, пригласительные ссылки
- **Аккаунт** — профиль, приватность, активные сессии

Примеры готовых промптов для учеников: **[docs/FAQ.md](docs/FAQ.md)**.

---

## Как это устроено

```
Claude (Desktop / Code / Cursor)
        │  протокол MCP (stdio)
        ▼
~/.telegram-mcp/run.sh (или run.cmd)      ← обёртка: подхватывает ключи из telegram.env
        ▼
@overpod/mcp-telegram  (Node.js)          ← MCP-сервер, закреплённая версия 1.41.2
        │  протокол MTProto (как обычное приложение Telegram)
        ▼
Серверы Telegram  →  ваш аккаунт
```

Всё работает **локально на вашем компьютере**: ключи и сессия никуда не отправляются, кроме официальных серверов Telegram. Никаких сторонних сервисов и «облаков» между вами и Telegram нет.

Файлы после установки:

| Путь | Что это | Секрет? |
|------|---------|---------|
| `~/.telegram-mcp/server/` | сам MCP-сервер (npm-пакет) | нет |
| `~/.telegram-mcp/telegram.env` | ваши api_id / api_hash | **ДА** |
| `~/.telegram-mcp/session` | сессия входа в аккаунт | **ДА** |
| `~/.telegram-mcp/run.sh` / `run.cmd` | скрипт запуска | нет |
| `~/.telegram-mcp/server/doctor.mjs` | скрипт проверки | нет |

---

## Обновление

Установщик идемпотентный — просто запустите его ещё раз: он обновит сервер до версии, закреплённой в скрипте, и задаст два вопроса. На «Оставить текущие ключи?» ответьте **y**, на «Войти заново?» ответьте **n** — заново входить не нужно.

## Удаление

```bash
# macOS / Linux
bash <(curl -fsSL https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/uninstall.sh)
```

```powershell
# Windows
irm https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/uninstall.ps1 | iex
```

После удаления зайдите на телефоне: Telegram → Настройки → Устройства → завершите сессию «MCP Telegram», если она осталась.

---

## Несколько AI-агентов одновременно

Работаете сразу с Claude Code + Claude Desktop + Codex + Cursor + Antigravity? Соединение с Telegram может держать только один процесс — сервер сам разруливает это по схеме «один владелец, остальные клиенты». А чтобы закрытие любого агента не обрывало Telegram у остальных, настройте **фоновый сервис** (установщик предложит на шаге 6, или в любой момент: `~/.telegram-mcp/daemon-setup.sh install`).

Полное объяснение и подключение каждого агента: **[docs/08-multi-agent.md](docs/08-multi-agent.md)**.

## Если что-то не работает

1. **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — разобраны все типовые ошибки: Node не найден, QR не сканируется, `AUTH_KEY_DUPLICATED`, Claude не видит сервер, Telegram заблокирован провайдером и т.д.
2. Запустите доктор (команда выше) и приложите его вывод к вопросу.
3. **[docs/FAQ.md](docs/FAQ.md)** — частые вопросы: «забанят ли меня?», «видит ли Claude все мои переписки?», «как отключить?».

## Продвинутое

**[docs/ADVANCED.md](docs/ADVANCED.md)**: несколько аккаунтов на одном компьютере · общий daemon для нескольких клиентов одновременно · работа через прокси (SOCKS5 / MTProxy) · запуск без Node.js (готовые бинарники) · Cursor, VS Code и другие клиенты.

---

## Структура репозитория

```
telegram-mcp-starter/
├── install.sh / install.ps1        установка одной командой (macOS+Linux / Windows)
├── uninstall.sh / uninstall.ps1    полное удаление
├── tools/                          doctor.mjs (проверка), merge-config.mjs (конфиги),
│                                   daemon-setup.* (фоновый сервис), patch-win32-socket.mjs
├── configs/                        готовые примеры конфигов для всех клиентов
├── tests/ + .github/workflows/     автотесты на macOS, Linux и Windows при каждом изменении
└── docs/                           пошаговые инструкции, безопасность, FAQ, troubleshooting
```

## Благодарности и лицензия

- MCP-сервер: [`@overpod/mcp-telegram`](https://github.com/mcp-telegram/mcp-telegram) (MIT) — вся магия там.
- Библиотека MTProto: [GramJS](https://github.com/gram-js/gramjs).
- Этот репозиторий: [MIT License](LICENSE). Автор сборки: [Александр Фисенков](https://github.com/alexfisenkov), проект «Ai МАСТЕРСКАЯ».

Нашли ошибку в инструкции — откройте Issue, поможете следующим ученикам.
