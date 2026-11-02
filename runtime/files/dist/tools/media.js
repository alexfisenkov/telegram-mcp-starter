import { z } from "zod";
import { readFileSync, statSync } from "node:fs";  // Telegram MCP Starter (M22)
import { hostname } from "node:os";
import { basename } from "node:path";
import { fail, ok, READ_ONLY, requireConnection, sanitize, WRITE } from "./shared.js";
// Telegram MCP Starter (M22): 3,5 МБ дают в base64 меньше 5 МБ, это предел картинки в ответе модели.
const FIS_INLINE_MAX_BYTES = 3.5 * 1024 * 1024;
// Telegram MCP Starter (M22): автоматические клиенты считают незнакомый текст утратой файла и списывают
// его навсегда. Тексты teleproto о связи и флуде этих слов не содержат, поэтому переводим их здесь,
// на единственном выходе инструмента. Постоянные ошибки («has no media», «not found») не трогаем.
function fisDownloadFailure(e) {
    const text = e instanceof Error ? e.message : String(e);
    const seconds = e?.seconds ?? /^Please wait (\d+) seconds/.exec(text)?.[1];
    if (seconds !== undefined && !text.includes("FLOOD_WAIT"))
        return new Error(`FLOOD_WAIT_${seconds}: ${text}`);
    if (e?.errorMessage === "TIMEOUT" || /sender slot removed|while disconnected|Cannot read properties of null/i.test(text))
        return new Error(`Скачивание оборвалось: ${text}, connection не отвечает. Неполный файл удалён, вызов можно повторить.`);
    return e;
}
// Тип по содержимому: расширение документа в Telegram ничего не гарантирует.
function fisImageMime(b) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return "image/jpeg";
    if (b.subarray(0, 4).toString("latin1") === "\x89PNG")
        return "image/png";
    if (b.subarray(0, 3).toString("latin1") === "GIF")
        return "image/gif";
    if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
        return "image/webp";
    return undefined;
}
export function registerMediaTools(server, telegram) {
    server.registerTool("telegram-send-file", {
        description: "Send a file (photo, document, video, etc.) to a Telegram chat",
        inputSchema: {
            chatId: z.string().describe("Chat ID or username"),
            filePath: z.string().describe("Absolute path to file"),
            caption: z.string().optional().describe("File caption"),
            // Telegram MCP Starter (M20): classic caption entities in the same media message.
            parseMode: z.enum(["html", "md"]).optional().describe("Caption markup; omitted means literal plain text"),
            // Telegram MCP Starter (M11): отправка документом (оригинал без пережатия)
            asDocument: z.boolean().optional().describe("Send as document (no Telegram re-encode)"),
            // Telegram MCP Starter (M13): ответ и тема форума для файла
            replyTo: z.number().optional().describe("Message ID to reply to (in forums puts the file into that topic)"),
            topicId: z.number().optional().describe("Forum topic ID to send the file into"),
        },
        annotations: WRITE,
    }, async ({ chatId, filePath, caption, asDocument, replyTo, topicId, parseMode }, extra) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            // Telegram MCP Starter (M10): передаём прогресс долгой загрузки и возвращаем
            // messageId с проверенными метаданными вместо непроверяемого "sent".
            const result = await telegram.sendFile(chatId, filePath, caption, extra?.sendProgress, asDocument, replyTo, topicId, parseMode);
            return ok(JSON.stringify({ chatId, ...result }));
        }
        catch (e) {
            return fail(e);
        }
    });
    // Telegram MCP Starter (M20): preparation reads current account limits without sending anything.
    server.registerTool("telegram-prepare-media-caption", {
        description: "Parse a media caption and check the current account's live Telegram caption limit without sending. Returns text, entities with UTF-16 offsets, codepoint count and account limit.",
        inputSchema: {
            caption: z.string().describe("Complete caption"),
            parseMode: z.enum(["html", "md"]).optional().describe("Markup; omitted means literal text"),
        },
        annotations: READ_ONLY,
    }, async ({ caption, parseMode }) => {
        const err = await requireConnection(telegram); if (err) return fail(new Error(err));
        try {
            const prepared = await telegram.prepareMediaCaption(caption, parseMode);
            // Telegram MCP Starter (M20d): TL toJSON may retain original zero lengths after parsing.
            // Return bounded DTOs from actual properties; keep Api entities inside send/edit.
            const entities = prepared.entities.map(e => ({
                className: e.className, offset: e.offset, length: e.length,
                ...(e.url != null ? { url: e.url } : {}),
                ...(e.documentId != null ? { documentId: e.documentId.toString() } : {}),
            }));
            return ok(JSON.stringify({ ...prepared, entities }));
        }
        catch (e) { return fail(e); }
    });
    // Telegram MCP Starter (M21): preview first; apply requires an exact owner/target baseline.
    server.registerTool("telegram-replace-message-media", {
        description: "Replace the video of ONE existing own message at the SAME message ID. dryRun defaults true: returns peer/document/caption baseline without upload. Apply requires all expected baseline fields. Omitted caption preserves exact native text/entities. No send/delete fallback and no automatic retry; reconcile the same ID on outcome_unknown.",
        inputSchema: {
            chatId: z.string(), messageId: z.number().int().positive(), filePath: z.string(),
            expectedAccountId: z.string().regex(/^\d+$/),
            dryRun: z.boolean().default(true),
            expectedPeerKey: z.string().optional(),
            expectedDocumentId: z.string().regex(/^\d+$/).optional(),
            expectedCaptionSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
            expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Exact source SHA-256 returned by dryRun; required for apply"),
            caption: z.string().optional(), parseMode: z.enum(["html", "md"]).optional(),
        }, annotations: WRITE,
    }, async (args, extra) => {
        const err = await requireConnection(telegram); if (err) return fail(new Error(err));
        try { return ok(JSON.stringify(await telegram.replaceMessageMedia(args, extra?.sendProgress))); }
        catch (e) { return fail(e); }
    });
    server.registerTool("telegram-edit-media-caption", {
        description: "Edit only the caption of an existing outgoing photo/video/document. Supports classic bold and link entities, checks the live account limit, and never replaces/uploads the media. Read the same messageId back after editing.",
        inputSchema: {
            chatId: z.string().describe("Chat ID or username"),
            messageId: z.number().int().positive().describe("Existing outgoing media message ID"),
            caption: z.string().describe("Complete replacement caption; empty clears it"),
            parseMode: z.enum(["html", "md"]).optional().describe("Markup; omitted means literal text"),
        },
        annotations: WRITE,
    }, async ({ chatId, messageId, caption, parseMode }) => {
        const err = await requireConnection(telegram); if (err) return fail(new Error(err));
        try { return ok(JSON.stringify(await telegram.editMediaCaption(chatId, messageId, caption, parseMode))); }
        catch (e) { return fail(e); }
    });
    server.registerTool("telegram-download-media", {
        // Telegram MCP Starter (M22): сервер может быть удалённым, его диск — не диск вызывающего.
        description: "Download media from a Telegram message to a file on the machine where this MCP server runs. A remote server cannot write to the caller's disk: omit downloadPath and the file is saved in the server's downloads folder for 3 days, and the reply gives its path and a command to fetch it. Set inline=true to also get an image right in the reply.",
        inputSchema: {
            chatId: z.string().describe("Chat ID or username"),
            messageId: z.number().describe("Message ID containing media"),
            downloadPath: z.string().optional().describe("Absolute path on the MCP server machine, its directory must exist. Omit to use the server's downloads folder."),
            // Telegram MCP Starter (R5): медиа внутри Rich-блоков (вне message.media)
            richIndex: z.number().int().min(0).optional().describe("Rich message media: 0-based index over richMedia.photos then richMedia.documents (the i in [rich-медиа i …]). Omit for ordinary media."),
            // Telegram MCP Starter (M22)
            inline: z.boolean().optional().describe("Also return the image inside the reply (jpg, png, webp, gif up to 3.5 MB)"),
        },
        annotations: READ_ONLY,
    }, async ({ chatId, messageId, downloadPath, richIndex, inline }, extra) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            // Telegram MCP Starter (M8): прогресс скачивания уходит клиенту
            const path = await telegram.downloadMedia(chatId, messageId, downloadPath, extra?.sendProgress, richIndex);
            // Telegram MCP Starter (M22): первая строка неизменна, её разбирают докачка и бот.
            const lines = [`Media downloaded to ${path}`];
            if (!downloadPath) {
                const host = hostname();
                lines.push(`Размер: ${statSync(path).size} байт. Файл лежит на машине ${host} и хранится 3 суток.`);
                lines.push(`Забрать на свою машину: ssh ${host} "cat '${path}'" > '${basename(path)}'`);
            }
            if (inline && statSync(path).size > FIS_INLINE_MAX_BYTES) {
                lines.push("В ответ не вложено: файл больше 3,5 МБ.");
            }
            else if (inline) {
                const bytes = readFileSync(path);
                const mimeType = fisImageMime(bytes);
                if (mimeType)
                    return { content: [{ type: "text", text: lines.join("\n") }, { type: "image", data: bytes.toString("base64"), mimeType }] };
                lines.push("В ответ не вложено: это не jpg, png, webp или gif.");
            }
            return ok(lines.join("\n"));
        }
        catch (e) {
            return fail(fisDownloadFailure(e));
        }
    });
    server.registerTool("telegram-get-profile-photo", {
        description: "Download profile photo of a Telegram user, group, or channel. Returns inline image or saves to file",
        inputSchema: {
            entityId: z.string().describe("User/Chat/Channel ID or username"),
            savePath: z.string().optional().describe("Absolute path to save file. If omitted, returns inline base64 image"),
            size: z
                .enum(["small", "big"])
                .optional()
                .describe("Photo size: 'small' (160x160) or 'big' (640x640). Default: big"),
        },
        annotations: READ_ONLY,
    }, async ({ entityId, savePath, size }) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            const result = await telegram.downloadProfilePhoto(entityId, {
                isBig: size !== "small",
                savePath,
            });
            if (!result) {
                return ok("No profile photo found");
            }
            if ("filePath" in result) {
                return ok(`Downloaded to: ${result.filePath}`);
            }
            return {
                content: [
                    { type: "image", data: result.buffer.toString("base64"), mimeType: result.mimeType },
                    {
                        type: "text",
                        text: `Profile photo (${(result.buffer.length / 1024).toFixed(0)} KB, ${result.mimeType})`,
                    },
                ],
            };
        }
        catch (e) {
            return fail(e);
        }
    });
    server.registerTool("telegram-get-web-preview", {
        description: "Fetch Telegram's web-page preview metadata (type, title, description, site name) for a URL",
        inputSchema: {
            url: z
                .string()
                .url()
                .refine((u) => {
                try {
                    const p = new URL(u);
                    if (p.protocol !== "http:" && p.protocol !== "https:")
                        return false;
                    const host = p.hostname
                        .toLowerCase()
                        .replace(/^\[|\]$/g, "")
                        .replace(/\.$/, "");
                    if (host === "localhost" ||
                        // Trailing-dot and subdomain forms of localhost (e.g. "localhost.", "foo.localhost")
                        host.endsWith(".localhost") ||
                        // Unspecified: 0.0.0.0/8
                        /^0\./.test(host) ||
                        // IPv4 loopback
                        /^127\./.test(host) ||
                        // IPv6 loopback and unspecified address
                        host === "::1" ||
                        host === "::" ||
                        // Link-local (AWS metadata, etc.)
                        /^169\.254\./.test(host) ||
                        // RFC1918 private ranges
                        /^10\./.test(host) ||
                        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
                        /^192\.168\./.test(host) ||
                        // IETF Protocol Assignments: 192.0.0.0/24
                        /^192\.0\.0\./.test(host) ||
                        // Documentation ranges (TEST-NET-1/2/3, RFC 5737): 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
                        /^192\.0\.2\./.test(host) ||
                        /^198\.51\.100\./.test(host) ||
                        /^203\.0\.113\./.test(host) ||
                        // CGNAT (RFC 6598): 100.64.0.0/10
                        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
                        // Benchmark testing (RFC 2544): 198.18.0.0/15
                        /^198\.1[89]\./.test(host) ||
                        // IPv4 multicast: 224.0.0.0/4
                        /^2(2[4-9]|3\d)\./.test(host) ||
                        // Reserved (future use): 240.0.0.0/4 and broadcast
                        /^(24[0-9]|25[0-5])\./.test(host)) {
                        return false;
                    }
                    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or Node-normalized ::ffff:7f00:1)
                    if (/^::ffff:/i.test(host)) {
                        let v4 = host.replace(/^::ffff:/i, "");
                        // Node.js normalizes ::ffff:a.b.c.d to ::ffff:XXYY:ZZWW (hex pairs).
                        // Convert hex-pair form back to dotted decimal before range checks.
                        const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v4);
                        if (hexPair) {
                            const hi = hexPair[1].padStart(4, "0");
                            const lo = hexPair[2].padStart(4, "0");
                            v4 = [
                                parseInt(hi.slice(0, 2), 16),
                                parseInt(hi.slice(2, 4), 16),
                                parseInt(lo.slice(0, 2), 16),
                                parseInt(lo.slice(2, 4), 16),
                            ].join(".");
                        }
                        if (/^0\./.test(v4) ||
                            /^127\./.test(v4) ||
                            /^10\./.test(v4) ||
                            /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
                            /^192\.168\./.test(v4) ||
                            /^192\.0\.0\./.test(v4) ||
                            /^192\.0\.2\./.test(v4) ||
                            /^198\.51\.100\./.test(v4) ||
                            /^203\.0\.113\./.test(v4) ||
                            /^169\.254\./.test(v4) ||
                            /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) ||
                            /^198\.1[89]\./.test(v4) ||
                            /^2(2[4-9]|3\d)\./.test(v4) ||
                            /^(24[0-9]|25[0-5])\./.test(v4)) {
                            return false;
                        }
                    }
                    // Private IPv6: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, documentation 2001:db8::/32
                    if (/^f[cd][0-9a-f]/i.test(host) ||
                        /^fe[89ab][0-9a-f]/i.test(host) ||
                        /^ff[0-9a-f]{2}/i.test(host) ||
                        /^2001:0?db8:/i.test(host)) {
                        return false;
                    }
                    return true;
                }
                catch {
                    return false;
                }
            }, "Only http:// and https:// URLs are allowed; literal loopback, private, link-local, and reserved IP addresses are blocked (DNS-backed hostnames that resolve to private ranges are not checked)")
                .describe("URL to preview (http:// or https://; literal private/loopback/reserved IPs rejected)"),
        },
        annotations: READ_ONLY,
    }, async ({ url }) => {
        const err = await requireConnection(telegram);
        if (err)
            return fail(new Error(err));
        try {
            const preview = await telegram.getWebPreview(url);
            if (!preview)
                return ok("No preview available");
            const lines = [`type: ${preview.type}`];
            if (preview.url)
                lines.push(`url: ${preview.url}`);
            if (preview.siteName)
                lines.push(`site: ${sanitize(preview.siteName)}`);
            if (preview.title)
                lines.push(`title: ${sanitize(preview.title)}`);
            if (preview.description)
                lines.push(`description: ${sanitize(preview.description)}`);
            return ok(lines.join("\n"));
        }
        catch (e) {
            return fail(e);
        }
    });
}
