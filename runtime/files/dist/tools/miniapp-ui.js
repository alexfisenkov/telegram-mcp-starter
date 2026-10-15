// Telegram MCP Starter (M4): инструменты чтения и управления открытым мини-приложением.
import { z } from "zod";
import { clickMiniApp, closeMiniApp, fillMiniApp, readMiniApp, screenshotMiniApp } from "../miniapp-browser.js";
import { fail, ok, READ_ONLY, WRITE } from "./shared.js";

function renderState(state) {
    const elements = state.elements.length
        ? state.elements.map((e) => `  ${e.ref} <${e.tag}> ${e.label || "—"}`).join("\n")
        : "  (интерактивных элементов не найдено)";
    return [`Заголовок: ${state.title}`, "", state.text || "(страница пуста)", "", "Элементы:", elements].join("\n");
}

export function registerMiniAppUiTools(server, _telegram) {
    server.registerTool("telegram-miniapp-read", {
        description: "Read the currently open Telegram mini app: page text and clickable elements with refs",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        try {
            return ok(renderState(await readMiniApp()));
        }
        catch (e) {
            return fail(e);
        }
    });

    server.registerTool("telegram-miniapp-click", {
        description: "Click an element inside the open mini app. Changing action: confirm with the human before purchases or anything irreversible.",
        inputSchema: {
            ref: z.string().optional().describe("Element ref from telegram-miniapp-read, e.g. ref_3"),
            text: z.string().optional().describe("Visible text to click, when no ref is known"),
        },
        annotations: WRITE,
    }, async ({ ref, text }) => {
        // Telegram MCP Starter: клик уже произошёл к этому моменту — если следующее
        // чтение состояния упадёт (страница ушла, DOM перестраивается), результат
        // самого клика нельзя терять за ошибкой чтения, иначе модель нажмёт повторно.
        let done;
        try {
            done = await clickMiniApp({ ref, text });
        }
        catch (e) {
            return fail(e);
        }
        try {
            return ok(`${done}\n\n${renderState(await readMiniApp())}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return ok(`${done}\n\nДействие выполнено, но состояние прочитать не удалось (${msg}). Вызовите telegram-miniapp-read отдельно.`);
        }
    });

    server.registerTool("telegram-miniapp-fill", {
        description: "Type a value into an input inside the open mini app. Changing action: confirm with the human before purchases or anything irreversible.",
        inputSchema: {
            ref: z.string().describe("Element ref from telegram-miniapp-read"),
            value: z.string().describe("Text to type"),
        },
        annotations: WRITE,
    }, async ({ ref, value }) => {
        // Telegram MCP Starter: тот же порядок, что у click — действие уже сделано,
        // неудачное чтение состояния не должно превращать успех в ошибку.
        let done;
        try {
            done = await fillMiniApp(ref, value);
        }
        catch (e) {
            return fail(e);
        }
        try {
            return ok(`${done}\n\n${renderState(await readMiniApp())}`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return ok(`${done}\n\nДействие выполнено, но состояние прочитать не удалось (${msg}). Вызовите telegram-miniapp-read отдельно.`);
        }
    });

    server.registerTool("telegram-miniapp-screenshot", {
        description: "Screenshot of the open mini app as a PNG image",
        inputSchema: {},
        annotations: READ_ONLY,
    }, async () => {
        try {
            return { content: [{ type: "image", data: await screenshotMiniApp(), mimeType: "image/png" }] };
        }
        catch (e) {
            return fail(e);
        }
    });

    server.registerTool("telegram-miniapp-close", {
        description: "Close the open mini app and release the browser",
        inputSchema: {},
        annotations: WRITE,
    }, async () => {
        try {
            await closeMiniApp();
            return ok("Мини-приложение закрыто");
        }
        catch (e) {
            return fail(e);
        }
    });
}
