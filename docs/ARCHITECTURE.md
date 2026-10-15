# Архитектура и выпуск

## Состав установленного runtime

Публичный дистрибутив закреплён в корневых `package.json` и `package-lock.json`: Node.js 22+, `@overpod/mcp-telegram@1.43.1`, `telegram` через override `npm:teleproto@1.229.0` и Playwright 1.62.1. Сам upstream пакет — лишь база runtime. Установщик применяет к нему 17 файловых postimages из `runtime/files/`; их ожидаемые версии и SHA-256 перечислены в `runtime/manifest.json`, а применение и проверка выполняются `tools/apply-patches.mjs`.

Публичный перечень манифеста содержит 13 upstream postimages и 4 новых файла расширения. Вместе они добавляют 11 инструментов: `telegram-pin-topic`, `telegram-reorder-pinned-topics`; четыре MTProto-инструмента Mini Apps (`telegram-list-mini-apps`, `telegram-get-mini-app-info`, `telegram-open-mini-app`, `telegram-prolong-mini-app`); пять UI-инструментов (`telegram-miniapp-read`, `telegram-miniapp-click`, `telegram-miniapp-fill`, `telegram-miniapp-screenshot`, `telegram-miniapp-close`). Расширение использует MTProto для открытия mini app и локальный Playwright слой для взаимодействия с интерфейсом. Наличие пакета Playwright не гарантирует наличие скачанного Chromium; установка браузера может потребоваться отдельно и не выполняется автоматически как часть установки runtime.

Базовая конфигурация публикует 180 инструментов. Ещё 13 инструментов доступны только при явном включении трёх opt-in групп: `MCP_TELEGRAM_ENABLE_GROUP_CALLS=1`, `MCP_TELEGRAM_ENABLE_STARS=1`, `MCP_TELEGRAM_ENABLE_QUICK_REPLIES=1`; вместе получается 193.

## Границы компонентов

- `package.json` и lockfile задают версии зависимостей.
- `runtime/manifest.json` задаёт строгий allowlist путей, upstream preimage hashes и финальные hashes.
- `runtime/files/` хранит утверждённые postimages, включая новые source-файлы расширения.
- `tools/apply-patches.mjs` проверяет идентичность пакета, alias и hashes; он отказывается менять неизвестный upstream drift или частично изменённые файлы.
- `install.sh` и `install.ps1` — пользовательский путь установки. Они фиксируют release tag в commit SHA, скачивают его архив, выполняют `npm ci --ignore-scripts`, применяют и проверяют postimages, затем активируют runtime с сохранением предыдущей серверной папки.
- `tools/doctor.mjs` разделяет безопасную проверку каталога инструментов и явный авторизованный `--status`.

## Источник и потребители

Корень этого репозитория — публичная source distribution для пользовательских локальных установок. Серверная инфраструктура, приватные репозитории, owner credentials и operational evidence в него не входят. Существующие URL `install.sh`, `install.ps1`, uninstall-скриптов и пользовательских lesson-ссылок следует сохранять.

Поддерживай синхронность lockfile, манифеста, runtime-файлов, release packager и документации. При изменении списка инструментов обнови `docs/TOOLS.md` по фактически собранному каталогу, а не по предположению из upstream README.

## Проверки и выпуск

Локальная последовательность из `AGENTS.md`: `npm ci --ignore-scripts`, `npm run runtime:apply`, `npm test`, `npm run test:smoke`. Установщики допускается проверять только с изолированным install root и runtime-only/test inputs; не направляй их в домашнюю установку разработчика и не входи в реальный Telegram в тестах.

Для публичного релиза используй source allowlist из release packager, зафиксированный source SHA, redacted secret/privacy review и один финальный ручной GitHub Actions прогон после готового diff. Публикация source distribution и отдельный серверный rollout — разные этапы; успешная сборка сама по себе не доказывает установку Windows service или работу live аккаунта.
