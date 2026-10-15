// Telegram MCP Starter (M2): инструменты мини-приложений Telegram, слой MTProto.
// Добыча авторизованной ссылки. Рендер (M4) делегирован в miniapp-browser.js,
// сами клики и чтение живут отдельно в miniapp-ui.js.
import { z } from "zod";
import { openMiniApp, readMiniApp } from "../miniapp-browser.js"; // Telegram MCP Starter (M4)
import { fail, ok, READ_ONLY, requireConnection, WRITE } from "./shared.js";

export function registerMiniAppTools(server, telegram) {
    server.registerTool("telegram-list-mini-apps", {
        description: "List Telegram mini apps available to this account (attachment menu bots)",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            const apps = await telegram.listAttachMenuMiniApps();
            if (!apps.length)
                return ok("Мини-приложений в меню вложений нет");
            return ok(apps
                .map((a) => `${a.shortName} (bot ${a.botId})${a.inactive ? " [не добавлено]" : ""}${a.requestWriteAccess ? " [просит доступ на запись]" : ""}`)
                .join("\n"));
        }
        catch (e) {
            return fail(e);
        }
    });

    server.registerTool("telegram-get-mini-app-info", {
        description: "Get title, description and access requirements of a named Telegram mini app",
        inputSchema: {
            bot: z.string().describe("Bot username or ID that owns the mini app"),
            appName: z.string().describe("Mini app short name, as in t.me/<bot>/<appName>"),
        },
        annotations: READ_ONLY,
    }, async ({ bot, appName }) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            const info = await telegram.getMiniAppInfo(bot, appName);
            return ok([
                `Название: ${info.title}`,
                `Короткое имя: ${info.shortName}`,
                `Описание: ${info.description || "—"}`,
                `Добавлено пользователем: ${info.inactive ? "нет" : "да"}`,
                `Просит доступ на запись: ${info.requestWriteAccess ? "да" : "нет"}`,
            ].join("\n"));
        }
        catch (e) {
            return fail(e);
        }
    });

    server.registerTool("telegram-open-mini-app", {
        description: "Open a Telegram mini app and return its authorized URL. The URL carries signed tgWebAppData and acts as the logged-in user.",
        inputSchema: {
            bot: z.string().describe("Bot username or ID, e.g. DurgerKingBot"),
            appName: z.string().optional().describe("Named app short name (t.me/<bot>/<appName>); omit for the bot's main mini app"),
            startParam: z.string().optional().describe("start_param passed to the mini app"),
            peer: z.string().optional().describe("Chat the app is opened from; defaults to the bot chat"),
            platform: z.enum(["web", "android", "ios", "tdesktop"]).default("web").describe("Platform reported to the app: web, android, ios, tdesktop"),
            writeAllowed: z.boolean().default(false).describe("Grant the app permission to message you. Ask the human before enabling."),
            render: z.boolean().default(false).describe("Also open the app in the built-in browser and return its content"),
        },
        annotations: WRITE,
    }, async ({ bot, appName, startParam, peer, platform, writeAllowed, render }) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            const { url, queryId } = await telegram.requestMiniAppUrl({
                bot, appName, startParam, peer, platform, writeAllowed,
            });
            const opened = `Мини-приложение открыто: ${appName ? `${bot}/${appName}` : bot}`;
            if (!render) {
                return ok([opened, `URL: ${url}`, `queryId: ${queryId ?? "—"}`].join("\n"));
            }
            // Telegram MCP Starter (M4): render=true — открыть URL в браузерном движке
            // (см. miniapp-browser.js) и сразу вернуть содержимое, а не только ссылку.
            // Telegram MCP Starter: URL несёт подписанные tgWebAppData и действует от имени
            // пользователя — при render=true он вызывающему не нужен вовсе (содержимое
            // уже возвращено), поэтому в ответ идёт только домен, без данных.
            await openMiniApp(url);
            const state = await readMiniApp();
            const elements = state.elements.length
                ? state.elements.map((e) => `  ${e.ref} <${e.tag}> ${e.label || "—"}`).join("\n")
                : "  (интерактивных элементов не найдено)";
            let origin = "—";
            try {
                origin = new URL(url).origin;
            }
            catch {
                // если разбор не удался, оставляем прочерк — полный URL всё равно не печатаем
            }
            const head = [opened, `Домен: ${origin}`, `queryId: ${queryId ?? "—"}`].join("\n");
            return ok([head, "", `Заголовок: ${state.title}`, "", state.text || "(страница пуста)", "", "Элементы:", elements].join("\n"));
        }
        catch (e) {
            return fail(e);
        }
    });

    server.registerTool("telegram-prolong-mini-app", {
        description: "Keep a mini app session alive using the queryId returned by telegram-open-mini-app",
        inputSchema: {
            bot: z.string().describe("Bot username or ID"),
            queryId: z.string().describe("queryId from telegram-open-mini-app"),
            peer: z.string().optional().describe("Chat the app was opened from; defaults to the bot chat"),
        },
        annotations: WRITE,
    }, async ({ bot, queryId, peer }) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        // Telegram MCP Starter (M2): queryId приходит от модели строкой и уходит в
        // bigInt(queryId) внутри клиента — на мусорном значении библиотека
        // падает невнятной ошибкой, поэтому проверяем формат заранее.
        if (!/^\d+$/.test(queryId)) {
            return fail(new Error("queryId должен состоять только из цифр (значение из telegram-open-mini-app)"));
        }
        try {
            await telegram.prolongMiniApp({ bot, queryId, peer });
            return ok("Сессия мини-приложения продлена");
        }
        catch (e) {
            return fail(e);
        }
    });
}
