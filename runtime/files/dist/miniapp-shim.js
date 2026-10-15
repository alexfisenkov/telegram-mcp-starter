// Telegram MCP Starter (M3): эмуляция контейнера Telegram для мини-приложений.
// Апп получает данные из #tgWebAppData, но часть аппов дополнительно проверяет
// наличие контейнера и без него показывает «откройте в Telegram».
// Ставится через addInitScript() — ДО скриптов страницы; инъекция после загрузки
// опаздывает, SDK успевает решить, что окружения нет.
export const TELEGRAM_CONTAINER_SHIM = `
(() => {
  // Telegram MCP Starter (M3, дефект 2): настоящий SDK (telegram-web-app.js) слушает
  // ответы контейнера на window.Telegram.WebView.receiveEvent — подстроки
  // "WebApp.receiveEvent" в оригинальном SDK нет вообще. Доставляем по верному
  // пути, а WebApp.receiveEvent оставляем запасным на случай другой версии SDK.
  // Доставка отложена через setTimeout(0): postEvent может быть вызван раньше,
  // чем SDK успеет присвоить window.Telegram.WebView — синхронная доставка
  // потеряла бы ответ на самый первый запрос (обычно web_app_request_theme).
  const receive = (type, data) => {
    setTimeout(() => {
      try {
        if (window.Telegram?.WebView?.receiveEvent) {
          window.Telegram.WebView.receiveEvent(type, data);
          return;
        }
      } catch (e) { /* контейнер ещё не поднялся — пробуем запасной путь */ }
      try {
        window.Telegram?.WebApp?.receiveEvent?.(type, data);
      } catch (e) { /* апп ещё не поднял SDK — не мешаем загрузке */ }
    }, 0);
  };
  const viewport = () => ({
    height: window.innerHeight,
    width: window.innerWidth,
    is_expanded: true,
    is_state_stable: true,
  });
  const theme = () => ({
    theme_params: {
      bg_color: "#ffffff",
      text_color: "#000000",
      hint_color: "#707579",
      link_color: "#3390ec",
      button_color: "#3390ec",
      button_text_color: "#ffffff",
      secondary_bg_color: "#f4f4f5",
    },
  });
  window.TelegramWebviewProxy = {
    postEvent(type, data) {
      switch (type) {
        case "web_app_request_viewport": return receive("viewport_changed", viewport());
        case "web_app_request_theme":    return receive("theme_changed", theme());
        case "web_app_request_safe_area":
          return receive("safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
        case "web_app_request_content_safe_area":
          return receive("content_safe_area_changed", { top: 0, bottom: 0, left: 0, right: 0 });
        case "web_app_ready":
        case "web_app_expand":
        case "web_app_set_header_color":
        case "web_app_set_background_color":
          return undefined;
        default:
          return undefined; // неизвестные события гасим молча, чтобы не ронять апп
      }
    },
  };
})();
`;
