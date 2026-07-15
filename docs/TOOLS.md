# Все инструменты по категориям (168 по умолчанию + 13 опциональных)

Полный справочник того, что Claude может делать в вашем Telegram после подключения. Названия инструментов приведены для понимания — **запоминать их не нужно**: пишете Claude обычным языком («перешли это сообщение Ивану»), он сам выбирает инструмент.

Источник: [@overpod/mcp-telegram v1.41.x](https://github.com/mcp-telegram/mcp-telegram). Инструменты с пометкой *(Premium)* требуют Telegram Premium на вашем аккаунте.

## Подключение
`telegram-status` (кто я / всё ли работает), `telegram-login` (вход по QR), `telegram-logout`

## Сообщения
`telegram-send-message` (в т.ч. ответ с цитатой и эффектами), `telegram-edit-message`, `telegram-delete-message`, `telegram-forward-message`, `telegram-send-typing` («печатает…»), `telegram-translate-message`, `telegram-get-message-link`

## Отложенные сообщения
`telegram-send-scheduled` (создать отложенное), `telegram-get-scheduled` (список отложенных), `telegram-delete-scheduled` (удалить отложенное)

## Чтение и поиск
`telegram-list-chats`, `telegram-read-messages`, `telegram-search-messages` (по чату), `telegram-search-global` (по всем чатам сразу), `telegram-search-chats`, `telegram-get-unread`, `telegram-get-unread-mentions`, `telegram-get-unread-reactions`, `telegram-mark-as-read`, `telegram-get-replies`, `telegram-get-saved-dialogs` (Избранное)

## Черновики
`telegram-save-draft`, `telegram-get-drafts`, `telegram-clear-drafts`

## Медиа и файлы
`telegram-send-file`, `telegram-send-album` (2–10 фото/видео), `telegram-download-media`, `telegram-get-profile-photo`, `telegram-get-web-preview`

## Голос и видео
`telegram-send-voice` (голосовое), `telegram-send-video-note` (кружок), `telegram-transcribe-audio` *(Premium)* — расшифровка голосовых, `telegram-get-transcription`, `telegram-rate-transcription`

## Ещё отправка
`telegram-send-location` (геопозиция, в т.ч. live), `telegram-send-venue`, `telegram-send-contact`, `telegram-send-dice` (🎲🎯🎰🏀⚽🎳)

## Реакции
`telegram-send-reaction`, `telegram-get-reactions`, `telegram-set-default-reaction`, `telegram-get-top-reactions`, `telegram-get-recent-reactions`, `telegram-send-paid-reaction` (⭐), `telegram-get-paid-reaction-privacy`, `telegram-toggle-paid-reaction-privacy`, `telegram-set-chat-reactions`

## Опросы
`telegram-create-poll`, `telegram-vote-poll`, `telegram-get-poll-results`, `telegram-get-poll-voters`, `telegram-close-poll`

## Стикеры
`telegram-send-sticker`, `telegram-get-installed-stickers`, `telegram-get-recent-stickers`, `telegram-get-sticker-set`, `telegram-search-sticker-sets`

## Группы и каналы — управление
`telegram-create-group`, `telegram-edit-group`, `telegram-invite-to-group`, `telegram-join-chat`, `telegram-leave-group`, `telegram-kick-user`, `telegram-ban-user`, `telegram-unban-user`, `telegram-set-admin`, `telegram-remove-admin`, `telegram-get-my-role`, `telegram-set-chat-permissions`, `telegram-set-slow-mode`, `telegram-get-admin-log`, `telegram-approve-join-request`, `telegram-toggle-channel-signatures`, `telegram-toggle-anti-spam`, `telegram-toggle-forum-mode`, `telegram-toggle-prehistory-hidden`

## Информация о чатах
`telegram-get-chat-info`, `telegram-get-chat-members`, `telegram-get-message-read-participants` (кто прочитал), `telegram-get-outbox-read-date` (когда прочитали вас)

## Темы форумов (топики)
`telegram-list-topics`, `telegram-read-topic-messages`, `telegram-create-topic`, `telegram-edit-topic`, `telegram-delete-topic`

## Папки чатов
`telegram-get-chat-folders`, `telegram-create-folder`, `telegram-edit-folder`, `telegram-delete-folder`, `telegram-reorder-folders`, `telegram-get-suggested-folders`, `telegram-toggle-folder-tags`

## Настройки чатов
`telegram-mute-chat`, `telegram-archive-chat`, `telegram-pin-chat`, `telegram-mark-dialog-unread`, `telegram-pin-message`, `telegram-unpin-message`, `telegram-set-auto-delete`

## Инвайт-ссылки
`telegram-create-invite-link`, `telegram-get-invite-links`, `telegram-revoke-invite-link`

## Контакты
`telegram-get-contacts`, `telegram-add-contact`, `telegram-get-contact-requests`

## Модерация
`telegram-block-user`, `telegram-unblock-user`, `telegram-report-spam`

## Профиль и аккаунт
`telegram-get-profile`, `telegram-update-profile`, `telegram-set-profile-photo`, `telegram-delete-profile-photo`, `telegram-set-emoji-status` *(Premium)*, `telegram-list-emoji-statuses`, `telegram-clear-recent-emoji-statuses`, `telegram-set-profile-color` *(Premium)*, `telegram-set-birthday`, `telegram-set-personal-channel`, `telegram-get-sessions` (активные устройства), `telegram-terminate-session`, `telegram-set-privacy`, `telegram-get-global-privacy-settings`, `telegram-set-global-privacy-settings`

## Истории (Stories)
Чтение: `telegram-get-all-stories`, `telegram-get-peer-stories`, `telegram-get-stories-by-id`, `telegram-get-story-views`, `telegram-read-stories`.
Публикация: `telegram-send-story`, `telegram-edit-story`, `telegram-delete-stories`, `telegram-react-to-story`, `telegram-export-story-link`, `telegram-toggle-story-pinned`, `telegram-toggle-story-pinned-to-top`, `telegram-activate-stealth-mode` *(Premium)*, `telegram-get-stories-archive`, `telegram-report-story`

## Каналы: комментарии и статистика
`telegram-get-discussion-message`, `telegram-get-groups-for-discussion`, `telegram-get-broadcast-stats` (статистика канала), `telegram-get-megagroup-stats` (статистика супергруппы)

## Буст-система
`telegram-get-my-boosts`, `telegram-get-boosts-status`, `telegram-get-boosts-list`

## Telegram Business
`telegram-get-business-chat-links`, `telegram-create-business-chat-link`, `telegram-edit-business-chat-link`, `telegram-delete-business-chat-link`, `telegram-resolve-business-chat-link`, `telegram-set-business-hours`, `telegram-set-business-location`, `telegram-set-business-greeting`, `telegram-set-business-away`, `telegram-set-business-intro`

## Инлайн-боты и кнопки
`telegram-inline-query` (запрос к @боту), `telegram-inline-query-send`, `telegram-press-button` (нажать кнопку под сообщением), `telegram-get-message-buttons`

## Реальное время (обновления)
`telegram-get-state`, `telegram-get-updates`, `telegram-get-channel-updates`

## Прочее
`telegram-get-fact-check`, `telegram-edit-fact-check`, `telegram-delete-fact-check`

## Опциональные (выключены по умолчанию)

Включаются переменными окружения в `~/.telegram-mcp/telegram.env`:

| Добавить строку | Что откроется |
|-----------------|---------------|
| `MCP_TELEGRAM_ENABLE_GROUP_CALLS=1` | информация о групповых звонках и участниках |
| `MCP_TELEGRAM_ENABLE_STARS=1` | баланс Stars, транзакции, подписки, звёздные подарки |
| `MCP_TELEGRAM_ENABLE_QUICK_REPLIES=1` | быстрые ответы Telegram Business |

После изменения `telegram.env` перезапустите Claude.
