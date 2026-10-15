import { randomBytes } from "node:crypto";  // Telegram MCP Starter M9-fix-2: уникальное имя обрывка .part
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync, realpathSync } from "node:fs";  // Telegram MCP Starter R3: чтение/запись кэша имён; statSync — Telegram MCP Starter M7, проверка непустого файла после потокового скачивания; realpathSync — M10 dedup upload
import { chmod, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";  // Telegram MCP Starter (A11): MTProtoSender teleproto для печати
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fisTeleproto } from "./telegram-helpers.js";  // Telegram MCP Starter (R4b): загрузчик teleproto один на пакет
import bigInt from "big-integer";
import QRCode from "qrcode";
import { TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { getInputUser } from "telegram/Utils.js";
import { RateLimiter } from "./rate-limiter.js";
import { buildReplyTo, buildStoryPrivacyRules, describeAdminLogAction, describeAdminLogDetails, describeKeyboardButton, detectMediaType, extractDiceResult, extractMessageId, extractPeerId, extractPollMediaFromUpdates, extractStoryIdFromUpdates, generateRandomBigInt, mergeBannedRights, reactionToEmoji, summarizeAllStories, summarizeBoostsList, summarizeBoostsStatus, summarizeBroadcastStats, summarizeBusinessChatLink, summarizeBusinessChatLinks, summarizeChannelDifference, summarizeDiscussionMessage, summarizeEmojiStatus, summarizeGroupCall, summarizeGroupCallParticipants, summarizeGroupsForDiscussion, summarizeMegagroupStats, summarizeMyBoosts, summarizePeer, summarizePeerStories, summarizePoll, summarizeQuickReplies, summarizeQuickReplyMessages, summarizeReadParticipants, summarizeReportResult, summarizeSavedMusic, summarizeStarsStatus, summarizeStoriesById, summarizeStoryViewsList, summarizeUpdatesDifference, } from "./telegram-helpers.js";
import { GetSavedMusicRequest } from "./tl/saved-music.js";
export { buildStoryPrivacyRules, describeAdminLogAction, describeAdminLogDetails, describeKeyboardButton, detectMediaType, extractPeerId, extractPollMediaFromUpdates, extractStoryIdFromUpdates, mergeBannedRights, peerToCompact, reactionToEmoji, summarizeAllStories, summarizeBoost, summarizeBoostsList, summarizeBoostsStatus, summarizeBroadcastStats, summarizeBusinessChatLink, summarizeBusinessChatLinks, summarizeChannelDifference, summarizeDiscussionMessage, summarizeEmojiStatus, summarizeGroupCall, summarizeGroupCallInfo, summarizeGroupCallParticipant, summarizeGroupCallParticipants, summarizeGroupsForDiscussion, summarizeMegagroupStats, summarizeMyBoost, summarizeMyBoosts, summarizePeer, summarizePeerStories, summarizePoll, summarizePrepaidGiveaway, summarizeQuickReplies, summarizeQuickReply, summarizeQuickReplyMessage, summarizeQuickReplyMessages, summarizeReadParticipants, summarizeReportResult, summarizeSavedMusic, summarizeStarsAmount, summarizeStarsStatus, summarizeStarsSubscription, summarizeStarsTransaction, summarizeStarsTransactionPeer, summarizeStoriesById, summarizeStoryItem, summarizeStoryView, summarizeStoryViewsList, summarizeUpdatesDifference, } from "./telegram-helpers.js";
// Telegram MCP Starter (R4b): транспорт как у gramJS 2.26.22. gramJS в Node при useWSS ходил
// обычным TCP (PromisedNetSockets) к IP DC, меняя только порт главного DC: useWSS ? 443 : 80
// (TelegramClient.js:1081), порт из сессии не читал. teleproto опцию useWSS не знает и берёт
// порт главного DC из сессии (session.port || 80), остальные DC — 443. Ставим порт в
// сессии в памяти ровно как gramJS; адрес остаётся IP — откат на gramJS сессию читает.
// Настоящий WebSocket (networkSocket) не включаем: он переписал бы адрес в сессии на
// *.web.telegram.org. Пул медиасессий teleproto — 2–8 соединений на DC (у gramJS одно):
// держим одно, потолок — TELEGRAM_MEDIA_SESSIONS (1–8).
export function fisClientOptions(useWSS, session) {
    if (!fisTeleproto())
        return { useWSS };
    if (session?.serverAddress && session.dcId)
        session.setDC(session.dcId, session.serverAddress, useWSS ? 443 : 80);
    const n = Math.max(1, Math.min(8, Number.parseInt(process.env.TELEGRAM_MEDIA_SESSIONS ?? "1", 10) || 1));
    return { downloadPool: { sessions: 1, maxSessions: n } };
}
// Telegram MCP Starter: stop destroyed MTProto senders from reconnecting.
// teleproto умеет ОЖИТЬ: MTProtoSender.disconnect() ставит lifecycle "dead", но этот флаг
// не уважают (1) reconnect() — после sleep зовёт _reconnect() без проверки; (2) цикл
// connect() — после retryDelay (до 64 с) делает следующую попытку _connect(); (3) connect()
// переписывает "dead" на "connecting"; (4) _connect(), застигнутый посреди TCP-дозвона,
// ставит "connected" и запускает ввод-вывод. Ожившему старому sender рядом с новым
// клиентом на том же ключе — прямой путь к AUTH_KEY_DUPLICATED. Поэтому sender любого
// клиента, у которого стоит _destroyed (teleproto ставит его первой строкой destroy())
// или наш _fisSealed, больше не соединяется, не переподключается и не запускает IO —
// печать на прототипе, она же накрывает пул медиа (у всех sender есть _client).
const fisRequireTp = createRequire(import.meta.url);
function fisSenderSealed(sender) {
    const c = sender?._client;
    return !!(c && (c._fisSealed || c._destroyed));
}
function fisSealError() {
    return new Error("Telegram MCP Starter (A11): sender уничтоженного клиента не соединяется");
}
let fisSendersGuarded = false;
export function fisGuardSenders(P) {
    if (fisSendersGuarded && !P)
        return true;
    if (!P) {
        if (!fisTeleproto())
            return false;
        try {
            P = fisRequireTp("telegram/network/MTProtoSender.js").MTProtoSender.prototype;
        }
        catch {
            return false;
        }
    }
    if (P.__fisSealGuard)
        return (fisSendersGuarded = true);
    const orig = { connect: P.connect, _connect: P._connect, _startIo: P._startIo, reconnect: P.reconnect, _reconnect: P._reconnect };
    P.connect = async function (...args) {
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            throw fisSealError();
        }
        return orig.connect.apply(this, args);
    };
    P._connect = async function (...args) {
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            throw fisSealError();
        }
        const result = await orig._connect.apply(this, args);
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            try { this._stopIo?.(); } catch { }
            try { await this._connection?.disconnect?.(); } catch { }
            throw fisSealError();
        }
        return result;
    };
    P._startIo = function (connection, ...rest) {
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            Promise.resolve().then(() => connection?.disconnect?.()).catch(() => { });
            return;
        }
        return orig._startIo.call(this, connection, ...rest);
    };
    P.reconnect = function (...args) {
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            return;
        }
        return orig.reconnect.apply(this, args);
    };
    P._reconnect = async function (...args) {
        if (fisSenderSealed(this)) {
            this._lifecycle = "dead";
            return;
        }
        return orig._reconnect.apply(this, args);
    };
    P.__fisSealGuard = true;
    return (fisSendersGuarded = true);
}
fisGuardSenders();
// Telegram MCP Starter (R4b): пределы дотягивания усечённых Rich (messages.getRichMessage).
// Чтение укладывается в «бюджет + один вызов» (15 + 8 с) — меньше IPC-таймаута 30 с.
function fisEnvInt(name, dflt) {
    const n = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}
const fisRichCallMs = () => fisEnvInt("TELEGRAM_RICH_CALL_MS", 8000);
const fisRichReadMs = () => fisEnvInt("TELEGRAM_RICH_READ_MS", 15000);
const fisRichMaxPerRead = () => fisEnvInt("TELEGRAM_RICH_MAX_PER_READ", 10);
const FIS_RICH_BATCH = new WeakMap();
let fisRichLimiter = Promise.resolve();
function fisWithTimeout(p, ms, what) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: таймаут ${ms} мс`)), ms); })])
        .finally(() => clearTimeout(t));
}
const fisSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Telegram MCP Starter (R4b): ключ главного DC — из строки сессии на диске, не из памяти клиента.
async function fisSavedKey(sessionString) {
    try {
        const s = new StringSession(sessionString);
        await s.load();
        return s.authKey?.getKey() ?? undefined;
    }
    catch {
        return undefined;
    }
}
// Rich-текст → дерево без циклов и без двоичных полей: только то, что читает человек
// или сборщик базы. Фото/документы — ссылкой по id, без file_reference.
const FIS_TL_SKIP = new Set(["CONSTRUCTOR_ID", "SUBCLASS_OF_ID", "classType", "className", "flags", "flags2", "_client", "originalArgs"]);
function fisTlToJson(v, depth = 0) {
    if (v === null || v === undefined)
        return v ?? null;
    if (depth > 24)
        return "…";
    if (typeof v === "bigint")
        return v.toString();
    if (typeof v !== "object")
        return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array)
        return { bytes: v.length };
    if (typeof v.toJSNumber === "function" && typeof v.isNegative === "function")
        return v.toString();
    if (Array.isArray(v))
        return v.map((x) => fisTlToJson(x, depth + 1));
    const out = v.className ? { _: v.className } : {};
    for (const [k, x] of Object.entries(v)) {
        if (FIS_TL_SKIP.has(k) || typeof x === "function")
            continue;
        if (k === "photo" || k === "document") {
            out[k] = x && x.id !== undefined ? { id: String(x.id) } : fisTlToJson(x, depth + 1);
            continue;
        }
        out[k] = fisTlToJson(x, depth + 1);
    }
    return out;
}
function fisRichMentions(rich) {
    const found = [];
    const walk = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 40)
            return;
        if (Array.isArray(node)) {
            for (const x of node)
                walk(x, depth + 1);
            return;
        }
        if (node.className === "TextMentionName" && node.userId !== undefined) {
            const tp = fisTeleproto();
            found.push({ userId: String(node.userId), text: tp ? tp.rich.renderRichText(node.text, "text") : "" });
        }
        for (const [k, x] of Object.entries(node)) {
            if (k === "photos" || k === "documents" || FIS_TL_SKIP.has(k))
                continue;
            if (x && typeof x === "object")
                walk(x, depth + 1);
        }
    };
    walk(rich.blocks, 0);
    return found;
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_SESSION_FILE = join(__dirname, "..", ".telegram-session");
const DEFAULT_SESSION_DIR = process.env.TELEGRAM_DATA_DIR?.trim() || join(homedir(), ".telegram-mcp");
const DEFAULT_SESSION_FILE = join(DEFAULT_SESSION_DIR, "session");
const SESSION_STRING_RE = /^[A-Za-z0-9+/=]+$/;
const MIN_SESSION_LENGTH = 100;
const NOT_CONNECTED_ERROR = "Not connected. Run telegram-status to check or telegram-login to authenticate.";
// Telegram MCP Starter (M10): GramJS 2.26.22 оставляет _getMetadata() пустым и для
// любого MP4 сам создаёт DocumentAttributeVideo с w=1, h=1, duration=0. В
// Telegram такое видео выглядит как плоская полоска. Перед upload читаем
// реальные параметры через ffprobe и при невозможности проверки останавливаем
// отправку: ложные 1x1 хуже явной ошибки.
const FIS_VIDEO_RE = /\.(?:mp4|m4v|mov|webm)$/i;
function fisProbeVideo(filePath) {
    if (!FIS_VIDEO_RE.test(filePath))
        return null;
    if (!existsSync(filePath) || !statSync(filePath).isFile())
        throw new Error(`Video file not found: ${filePath}`);
    const candidates = [
        process.env.FFPROBE_PATH,
        "/opt/homebrew/bin/ffprobe",
        "/usr/local/bin/ffprobe",
        "ffprobe",
    ].filter(Boolean);
    let lastError = "ffprobe is unavailable";
    for (const bin of candidates) {
        if (bin.startsWith("/") && !existsSync(bin))
            continue;
        try {
            const raw = execFileSync(bin, [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "json",
                filePath,
            ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
            const probe = JSON.parse(raw);
            const stream = probe?.streams?.[0] ?? {};
            const width = Number(stream.width);
            const height = Number(stream.height);
            const duration = Number(probe?.format?.duration);
            if (![width, height, duration].every((value) => Number.isFinite(value) && value > 0))
                throw new Error("ffprobe returned incomplete video metadata");
            return {
                width: Math.round(width),
                height: Math.round(height),
                duration: Math.ceil(duration),
            };
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`Cannot verify video metadata before Telegram upload: ${lastError}`);
}
// Telegram MCP Starter (M10-fix): строковые aliases (`me`, `@me`, `self`), username,
// display name и числовой id могут обозначать один peer. Upload-lock строим по
// каноническому InputPeer, иначе разные написания обходят дедупликацию.
function fisInputPeerKey(peer) {
    if (peer instanceof Api.InputPeerSelf)
        return "self";
    if (peer instanceof Api.InputPeerUser)
        return `user:${peer.userId.toString()}`;
    if (peer instanceof Api.InputPeerChat)
        return `chat:${peer.chatId.toString()}`;
    if (peer instanceof Api.InputPeerChannel)
        return `channel:${peer.channelId.toString()}`;
    if (peer instanceof Api.InputPeerUserFromMessage)
        return `user-from:${peer.userId.toString()}:${peer.msgId}`;
    if (peer instanceof Api.InputPeerChannelFromMessage)
        return `channel-from:${peer.channelId.toString()}:${peer.msgId}`;
    throw new Error(`Cannot build canonical Telegram upload target from ${peer?.className ?? typeof peer}`);
}
// Revoked or invalid auth keys cannot be repaired by reconnecting.
// Stop retries and require an explicit login instead of creating a reconnect loop.
const FATAL_AUTH_ERRORS = [
    "AUTH_KEY_DUPLICATED",
    "AUTH_KEY_INVALID",
    "AUTH_KEY_UNREGISTERED",
    "SESSION_REVOKED",
    "SESSION_EXPIRED",
    "USER_DEACTIVATED",
];
// Эти три и до патча приводили к удалению локального файла сессии — поведение сохраняем.
// AUTH_KEY_DUPLICATED сюда НЕ входит осознанно: при дубликате локальный файл может быть
// ещё пригоден, и решение «стереть сессию» должен принимать человек, а не автоматика.
const SESSION_WIPE_ERRORS = new Set(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED"]);
const SESSION_DEAD_ERROR = "Сессия Telegram отозвана — нужен повторный вход (telegram-login). Автоматические переподключения отключены до ручного входа.";
// Telegram MCP Starter (A7): негативный бэкофф 1с → 5с → 30с → 5мин. До патча неудачный
// коннект повторялся на каждом вызове инструмента без паузы.
const RECONNECT_BACKOFF_MS = [1000, 5000, 30000, 300000];
// Telegram MCP Starter (R4b): имя ошибки сравнивается целиком. Подстрока ловила чужое:
// «400 INPUT_USER_DEACTIVATED» (бан удалённого ученика) содержит USER_DEACTIVATED и
// останавливала весь демон.
function fisFatalNameIn(msg) {
    return FATAL_AUTH_ERRORS.find((k) => new RegExp(`(^|[^A-Z0-9_])${k}([^A-Z0-9_]|$)`).test(msg ?? ""));
}
/** Telegram MCP Starter (R4b): имя фатальной ошибки ключа или "" — по errorMessage RPC точно. */
function fisFatalAuthName(err) {
    const name = typeof err?.errorMessage === "string" ? err.errorMessage : "";
    if (name)
        return FATAL_AUTH_ERRORS.includes(name) ? name : "";
    return fisFatalNameIn(String(err?.message ?? err ?? "")) ?? "";
}
function isFatalAuthError(msg, code) {
    if (fisFatalNameIn(msg))
        return true;
    // RPC-код 406 (NOT_ACCEPTABLE) Telegram отдаёт на «этот ключ больше не ваш». С именем
    // другой ошибки (TOPIC_CLOSED, FILEREF_UPGRADE_NEEDED — тоже 406) — не фатально.
    return code === 406 && !/[A-Z]{2,}_[A-Z0-9_]{2,}/.test(msg ?? "");
}
/**
 * Telegram's invite-bearing requests (`messages.createChat`, `messages.addChatUser`,
 * `channels.inviteToChannel`) do NOT return `Updates`. Their TL return type is
 * `messages.InvitedUsers`, which wraps the real `Updates` alongside the list of
 * users the server refused to add. GramJS types the field loosely enough that a
 * `result as unknown as Api.Updates` cast compiles while `.chats` is always
 * `undefined` at runtime.
 *
 * Both helpers tolerate the legacy bare-`Updates` shape so they stay correct if a
 * layer bump reverts the wrapper.
 */
function unwrapInvitedUsers(result) {
    if (result instanceof Api.messages.InvitedUsers)
        return result.updates;
    return result;
}
/** User IDs Telegram declined to invite (privacy settings, Premium-only DMs, limits). */
function missingInviteeIds(result) {
    if (!(result instanceof Api.messages.InvitedUsers))
        return [];
    return (result.missingInvitees ?? []).map((m) => m.userId.toString());
}
function resolveSessionPath(sessionPath) {
    return sessionPath ?? process.env.TELEGRAM_SESSION_PATH ?? DEFAULT_SESSION_FILE;
}
// Cloud password (2FA) for accounts that have two-step verification enabled.
// QR login alone cannot complete such logins — Telegram answers the imported
// login token with SESSION_PASSWORD_NEEDED, after which an SRP password check
// is required. Supplied via env so it works across all login entry points
// (standalone CLI, daemon IPC, and the telegram-login MCP tool), none of which
// can reliably prompt interactively mid-flow.
function resolveTwoFactorPassword() {
    return process.env.TELEGRAM_2FA_PASSWORD || undefined;
}
/**
 * Complete a QR login that Telegram answered with SESSION_PASSWORD_NEEDED by
 * running the SRP cloud-password check: GetPassword → computeCheck → CheckPassword.
 *
 * Returns a discriminated outcome rather than throwing so the caller owns
 * connection teardown. The password is only used to answer the SRP challenge
 * and is never logged or persisted.
 *
 * `compute` is injectable for tests; production always uses GramJS `computeCheck`.
 */
export async function completeTwoFactorLogin(client, password, compute = computeCheck) {
    if (!password) {
        return {
            ok: false,
            message: "2FA is enabled on this account. Set TELEGRAM_2FA_PASSWORD to your cloud password and run login again.",
        };
    }
    try {
        const passwordInfo = (await client.invoke(new Api.account.GetPassword()));
        const check = await compute(passwordInfo, password);
        await client.invoke(new Api.auth.CheckPassword({ password: check }));
        return { ok: true };
    }
    catch (pwErr) {
        const reason = pwErr instanceof Error ? pwErr.message : String(pwErr);
        return {
            ok: false,
            message: `2FA password check failed: ${reason}. Verify TELEGRAM_2FA_PASSWORD is correct.`,
        };
    }
}
function resolveProxy() {
    const ip = process.env.TELEGRAM_PROXY_IP;
    const port = process.env.TELEGRAM_PROXY_PORT;
    if (!ip || !port)
        return undefined;
    const secret =
            process.env.TELEGRAM_PROXY_SECRET;
    if (secret) {
        return { ip, port: Number(port), secret, MTProxy: true };
    }
    const socksType = Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || "5");
    return {
        ip,
        port: Number(port),
        socksType: socksType,
        ...(process.env.TELEGRAM_PROXY_USERNAME && { username: process.env.TELEGRAM_PROXY_USERNAME }),
        ...(process.env.TELEGRAM_PROXY_PASSWORD && { password:
                    process.env.TELEGRAM_PROXY_PASSWORD }),
    };
}
// When true, gramJS uses port 443 instead of the default 80 for the MTProto
// TCPFull transport. Useful on hosts where outbound port 80 to Telegram DC IP
// ranges is blocked. gramJS cannot combine useWSS with a proxy, so warn early
// rather than let it fail deep inside connect() with an opaque error.
function resolveUseWSS(proxy) {
    const useWSS = process.env.TELEGRAM_USE_WSS === "true";
    if (useWSS && proxy) {
        console.error("[mcp-telegram] TELEGRAM_USE_WSS=true cannot be combined with TELEGRAM_PROXY_* — gramJS does not support SSL transport over a proxy. Ignoring useWSS; the proxy takes precedence.");
        return false;
    }
    return useWSS;
}
// gramJS defaults its internal logger to INFO, which emits a line for every
// reconnect attempt ("Handling reconnect!", "connection closed", ...). On a
// host with a flaky path to the Telegram DC this becomes a tight reconnect
// storm that can grow the container stdout log to tens of GB and fill the
// disk. Cap it at ERROR by default so a storm can never flood stdout; allow
// override via TELEGRAM_LOG_LEVEL (none|error|warn|info|debug) for debugging.
function resolveBaseLogger() {
    const raw = (process.env.TELEGRAM_LOG_LEVEL || "error").toLowerCase();
    const level = raw === "none"
        ? LogLevel.NONE
        : raw === "warn"
            ? LogLevel.WARN
            : raw === "info"
                ? LogLevel.INFO
                : raw === "debug"
                    ? LogLevel.DEBUG
                    : LogLevel.ERROR;
    return new Logger(level);
}
function ensureSessionDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
// Sender-name cache: successful lookups are reused and concurrent misses are coalesced.
// Keep the cache beside this installation's session to avoid mixing account data.
const FIS_CACHE_PATH = process.env.MCP_TELEGRAM_ENTITY_CACHE
    || join(process.env.TELEGRAM_SESSION_PATH
        ? dirname(process.env.TELEGRAM_SESSION_PATH)
        : DEFAULT_SESSION_DIR, "entity-names.json");
const FIS_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;      // имя человека
const FIS_CACHE_MAX = 5000;
const fisNameCache = new Map();                      // id -> {name, at}
// Coalesce concurrent entity lookups as well as caching completed results.
// Otherwise a parallel page read can issue the same network lookup repeatedly.
const fisInflight = new Map();                       // id -> Promise<string>
let fisCacheDirty = false;
let fisCacheLoaded = false;
function fisCacheLoad() {
    if (fisCacheLoaded)
        return;
    fisCacheLoaded = true;
    try {
        const raw = JSON.parse(readFileSync(FIS_CACHE_PATH, "utf-8"));
        for (const [k, v] of Object.entries(raw || {})) {
            if (v && typeof v.at === "number")
                fisNameCache.set(k, v);
        }
    }
    catch { /* нет файла или мусор — начинаем с пустого */ }
}
function fisCacheSave() {
    if (!fisCacheDirty)
        return;
    fisCacheDirty = false;
    try {
        if (fisNameCache.size > FIS_CACHE_MAX) {
            const old = [...fisNameCache.entries()].sort((a, b) => a[1].at - b[1].at)
                .slice(0, fisNameCache.size - FIS_CACHE_MAX);
            for (const [k] of old)
                fisNameCache.delete(k);
        }
        const tmp = FIS_CACHE_PATH + ".tmp";
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(fisNameCache)), { mode: 0o600 });
        renameSync(tmp, FIS_CACHE_PATH);
    }
    catch { /* не удалось сохранить — не повод падать */ }
}
function fisNameOf(entity, key) {
    if (!entity)
        return null;
    if (entity instanceof Api.User) {
        const parts = [entity.firstName, entity.lastName].filter(Boolean);
        const base = parts.join(" ") || "Unknown";
        return entity.username ? `${base} (@${entity.username})` : base;
    }
    if (entity instanceof Api.Channel || entity instanceof Api.Chat)
        return entity.title ?? "Group";
    return key;
}
function fisCacheGet(id) {
    fisCacheLoad();
    const hit = fisNameCache.get(String(id));
    if (!hit)
        return null;
    if (Date.now() - hit.at > FIS_CACHE_TTL_MS) {
        fisNameCache.delete(String(id));
        return null;
    }
    return hit.name;
}
// Failed lookups are not cached: a transient disconnect or rate limit does not mean
// the entity is missing, and a later read should be able to resolve its display name.
function fisCacheSet(id, name) {
    fisCacheLoad();
    fisNameCache.set(String(id), { name, at: Date.now() });
    fisCacheDirty = true;
}
export class TelegramService {
    client = null;
    apiId;
    apiHash;
    sessionString = "";
    connected = false;
    sessionPath;
    rateLimiter = new RateLimiter();
    lastTypingAt = new Map();
    entityCache = new Map();
    // Telegram MCP Starter (M10-fix): один и тот же файл нельзя параллельно отправлять
    // в один target. После внешнего timeout первый upload может продолжаться в
    // daemon; второй вызов раньше создавал независимый fileId/randomId и дубль.
    uploadsInFlight = new Set();
    lastError = "";
    // Telegram MCP Starter (A1): in-flight promise коннекта. Проверка this.connected и создание
    // new TelegramClient разделены await'ами, поэтому два параллельных connect() создавали
    // ДВА живых gramJS-клиента в одном процессе → второй коннект на том же auth_key →
    // AUTH_KEY_DUPLICATED и отзыв сессии.
    connecting = null;
    qrLoginInFlight = false;
    // Telegram MCP Starter (A7): липкий флаг «сессия мертва» + состояние негативного бэкоффа.
    sessionDead = false;
    sessionDeadReason = "";
    lastConnectError = "";
    reconnectAttempt = 0;
    nextConnectAllowedAt = 0;
    get sessionDir() {
        return dirname(this.sessionPath);
    }
    hasLocalSession() {
        return existsSync(this.sessionPath);
    }
    // ─── Session & Auth ────────────────────────────────────────────────────────
    getClient() {
        return this.client;
    }
    constructor(apiId, apiHash, options) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.sessionPath = resolveSessionPath(options?.sessionPath);
    }
    async loadSession() {
        // Try current session path
        if (existsSync(this.sessionPath)) {
            const raw = (await readFile(this.sessionPath, "utf-8")).trim();
            if (this.isValidSessionString(raw)) {
                this.sessionString = raw;
                // Fix permissions on existing files
                try {
                    await chmod(this.sessionPath, 0o600);
                }
                catch {
                    // Best-effort hardening: the session is already loaded and usable, so a
                    // filesystem that refuses chmod (mounted volume, Windows) must not fail login.
                }
                return true;
            }
        }
        // Migrate from legacy path (inside node_modules / package root)
        if (this.sessionPath === DEFAULT_SESSION_FILE && existsSync(LEGACY_SESSION_FILE)) {
            const raw = (await readFile(LEGACY_SESSION_FILE, "utf-8")).trim();
            if (this.isValidSessionString(raw)) {
                this.sessionString = raw;
                ensureSessionDir(this.sessionPath);
                await writeFile(this.sessionPath, raw, { encoding: "utf-8", mode: 0o600 });
                try {
                    await unlink(LEGACY_SESSION_FILE);
                }
                catch {
                    // Best-effort cleanup: migration to the new path already succeeded, so a
                    // leftover legacy file is cosmetic and must not fail the migration.
                }
                return true;
            }
        }
        return false;
    }
    isValidSessionString(value) {
        return value.length >= MIN_SESSION_LENGTH && SESSION_STRING_RE.test(value);
    }
    /** Set session string in memory (for programmatic / hosted use) */
    setSessionString(session) {
        this.sessionString = session;
    }
    /** Get the current session string (for external persistence) */
    getSessionString() {
        return this.sessionString;
    }
    async saveSession(session) {
        this.sessionString = session;
        try {
            ensureSessionDir(this.sessionPath);
            await writeFile(this.sessionPath, session, { encoding: "utf-8", mode: 0o600 });
        }
        catch {
            // File write may fail in containerized environments — session string is still in memory
        }
    }
    /**
     * True when our sticky `connected` flag disagrees with GramJS about the live transport.
     *
     * `this.connected` is set in connect() and cleared only by disconnect()/clearSession()/
     * logOut() — never when the MTProto socket dies. So once GramJS exhausts its
     * `connectionRetries` budget the flag stays true, ensureConnected() keeps returning true,
     * and every tool call is issued on a dead client and hangs forever (issue #71).
     *
     * GramJS exposes the real state via `get connected()` -> `_sender && _sender.isConnected()`.
     * Only an explicit `false` counts as dead — deliberately not "any non-true value". The
     * getter yields `undefined` when there is no sender yet, and a GramJS upgrade that renamed
     * or dropped the property would read as `undefined` too; under a `!== true` test that would
     * tear down and rebuild the client on every single call, a reconnect storm worse than the
     * bug being fixed. With `=== false` an unknown signal degrades to the old behaviour, while
     * the reported failure (sender present, transport down) still reads `false` and recovers.
     */
    isTransportDead() {
        // Telegram MCP Starter (A11): пересборка — только после ПОДТВЕРЖДЁННОЙ смерти. teleproto сам
        // переподключается (lifecycle reconnecting/connecting), и client.connected === false в
        // это окно — норма, а не смерть: пересборка посреди штатного переподключения и
        // порождала второго живого sender. Смерть — lifecycle "dead", державшийся не меньше
        // TELEGRAM_DEAD_CONFIRM_MS (15 с). Нет lifecycle (gramJS) — верим флагу, как до #71.
        if (this.client === null)
            return false;
        const lifecycle = this.client._sender?.lifecycle;
        if (lifecycle !== "dead") {
            this.fisDeadSince = 0;
            return false;
        }
        const now = Date.now();
        if (!this.fisDeadSince)
            this.fisDeadSince = now;
        return now - this.fisDeadSince >= fisEnvInt("TELEGRAM_DEAD_CONFIRM_MS", 15000);
    }
    /**
     * Telegram MCP Starter (A11): уничтожение клиента с потолком. Клиент запечатывается ДО destroy
     * (его sender больше не оживёт), destroy ждём не дольше TELEGRAM_DESTROY_MS (10 с).
     * Не уложился — false: нового клиента поверх недоразрушенного не строим, только бэкофф,
     * пока destroy не закончится (fisDestroyPending).
     */
    async fisDestroy(client) {
        if (!client)
            return true;
        client._fisSealed = true;
        const done = Promise.resolve().then(() => client.destroy()).catch(() => { });
        let timer;
        const ok = await Promise.race([
            done.then(() => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), fisEnvInt("TELEGRAM_DESTROY_MS", 10000));
            }),
        ]);
        clearTimeout(timer);
        if (!ok) {
            console.error("[mcp-telegram] destroy() старого клиента не уложился в потолок — новый клиент не строю до его конца");
            const pending = done.finally(() => {
                if (this.fisDestroyPending === pending)
                    this.fisDestroyPending = null;
            });
            this.fisDestroyPending = pending;
        }
        return ok;
    }
    /**
     * Tear down a client whose transport is gone so connect() can rebuild from the saved
     * session. This is the in-process equivalent of killing the master: same session string,
     * fresh sender. No-op when there is no client.
     */
    async dropDeadClient() {
        const dead = this.client;
        this.connected = false;
        this.client = null;
        this.entityCache.clear();
        if (!dead)
            return;
        // Telegram MCP Starter (A11): печать + потолок 10 с вместо голого destroy().
        await this.fisDestroy(dead);
    }
    /**
     * Force the next ensureConnected() to revalidate instead of trusting the cached flag.
     * Called when a caller observed a symptom the flag can't see (e.g. a tool call that hung
     * past its budget), so recovery doesn't have to wait for GramJS to notice.
     */
    markUnhealthy(reason) {
        if (!this.connected && !this.client)
            return;
        // Telegram MCP Starter (A11): зависший вызов не повод рвать живой клиент. Параллельные вызовы
        // (A6, докачка) идут на нём же, а у teleproto свой пинг и reconnect. Пометка — только
        // если sender уже "dead"; при connected/reconnecting/connecting — одна строка в лог.
        const lifecycle = this.client?._sender?.lifecycle;
        if (lifecycle !== undefined && lifecycle !== "dead") {
            console.error(`[mcp-telegram] ${reason}: соединение ${lifecycle} — клиента не пересобираю`);
            return;
        }
        this.lastError = `Connection marked unhealthy: ${reason}`;
        this.connected = false;
    }
    /**
     * Telegram MCP Starter (A1). Идемпотентный коннект — единственная точка входа.
     * Раньше два параллельных вызова (авто-коннект демона + первый tool-вызов, пришедший
     * в момент незавершённого коннекта) проходили проверку `this.connected` оба и каждый
     * создавал свой TelegramClient. Два живых клиента на одном auth_key = AUTH_KEY_DUPLICATED
     * и отзыв сессии Telegram'ом. Теперь второй вызов дожидается того же in-flight promise.
     */
    async connect() {
        if (this.connected && this.client && !this.isTransportDead())
            return true;
        // Telegram MCP Starter (A7): сессия отозвана — новые коннекты запрещены до ручного входа.
        if (this.sessionDead) {
            this.lastError = this.sessionDeadReason
                ? `${SESSION_DEAD_ERROR} (${this.sessionDeadReason})`
                : SESSION_DEAD_ERROR;
            return false;
        }
        if (this.connecting)
            return this.connecting;
        // Telegram MCP Starter (A7): негативный бэкофф — не долбим Telegram на каждом tool-вызове.
        const waitMs = this.nextConnectAllowedAt - Date.now();
        if (waitMs > 0) {
            this.lastError = `${this.lastConnectError || "Connection failed."} Следующая попытка подключения возможна через ${Math.ceil(waitMs / 1000)} с (бэкофф после неудачи).`;
            return false;
        }
        const inflight = this.connectOnce();
        this.connecting = inflight;
        try {
            return await inflight;
        }
        finally {
            // Telegram MCP Starter (A1): чистим только СВОЙ in-flight, чтобы не затереть чужой.
            if (this.connecting === inflight)
                this.connecting = null;
        }
    }
    /** Telegram MCP Starter (A1): тело коннекта. Вызывается ТОЛЬКО из connect() под in-flight promise. */
    async connectOnce() {
        // Telegram MCP Starter (A11): прошлый destroy не уложился в потолок — нового клиента не строим.
        if (this.fisDestroyPending) {
            this.lastError = "Предыдущий клиент Telegram ещё закрывается — новый не строю (бэкофф).";
            this.lastConnectError = this.lastError;
            this.bumpReconnectBackoff();
            return false;
        }
        if (!this.sessionString) {
            const loaded = await this.loadSession();
            if (!loaded)
                return false;
        }
        // Telegram MCP Starter (A1): предыдущий клиент мог остаться живым (например, после
        // неудачной проверки getMe). Убиваем его ДО создания нового — иначе на один
        // auth_key снова окажется два соединения.
        if (this.client) {
            const stale = this.client;
            this.client = null;
            this.connected = false;
            // Telegram MCP Starter (A11): печать + потолок; не уложился — бэкофф, без нового клиента.
            if (!(await this.fisDestroy(stale))) {
                this.lastError = "Предыдущий клиент Telegram не закрылся за потолок — новый не строю (бэкофф).";
                this.lastConnectError = this.lastError;
                this.bumpReconnectBackoff();
                return false;
            }
        }
        const session = new StringSession(this.sessionString);
        const proxy = resolveProxy();
        const client = new TelegramClient(session, this.apiId, this.apiHash, {
            connectionRetries: 5,
            ...fisClientOptions(resolveUseWSS(proxy), session),  // Telegram MCP Starter (R4b)
            baseLogger: resolveBaseLogger(),  // апстрим 1.41.2: логгер библиотеки не выше ERROR
            ...(proxy && { proxy }),
        });
        this.client = client;
        // Telegram MCP Starter (A7): мид-сессионный перехват фатальных ошибок вешаем ТОЛЬКО
        // свойством: опция errorHandler в конструкторе gramJS не читается, фикс бы молча
        // не сработал.
        this.installFatalErrorHandler(client);
        try {
            await client.connect();
            // Verify session is still valid
            await client.getMe();
            this.connected = true;
            // Успех — сбрасываем бэкофф и текст последней ошибки коннекта.
            this.reconnectAttempt = 0;
            this.nextConnectAllowedAt = 0;
            this.lastConnectError = "";
            return true;
        }
        catch (err) {
            const error = err;
            const msg = error.errorMessage || error.message || "";
            const code = typeof error.code === "number" ? error.code : undefined;
            // sessionDead мог уже выставить onError прямо посреди коннекта.
            const fatal = this.sessionDead || isFatalAuthError(msg, code);
            const failed = this.client;
            this.client = null;
            this.connected = false;
            if (fatal) {
                // Auth revoked — delete invalid session (историческое поведение для трёх кодов)
                if (SESSION_WIPE_ERRORS.has(msg)) {
                    await this.clearSession();
                }
                this.markSessionDead(msg || (code ? `RPC ${code}` : "session revoked"));
            }
            // Network error — keep session, just report
            else if (msg.includes("TIMEOUT") ||
                msg.includes("ECONNREFUSED") ||
                msg.includes("ENETUNREACH") ||
                msg.includes("ENOTFOUND") ||
                msg.includes("network")) {
                this.lastError = `Network error: ${msg}. Run telegram-status to retry connection.`;
                this.bumpReconnectBackoff();
            }
            // Unknown error
            else {
                this.lastError = `Connection error: ${msg}`;
                this.bumpReconnectBackoff();
            }
            this.lastConnectError = this.lastError;
            // Telegram MCP Starter (A1) + апстрим 1.43.1: неудачный клиент рвём destroy() всегда.
            // disconnect() оставлял живым цикл обновлений и _handleReconnect — зомби на том же
            // auth_key рядом со следующим клиентом.
            // Telegram MCP Starter (A11): печать + потолок 10 с.
            if (failed)
                await this.fisDestroy(failed);
            return false;
        }
    }
    /**
     * Telegram MCP Starter (A7). Липкий флаг «сессия мертва»: одна строка в лог вместо тысяч,
     * все инструменты получают понятную ошибку, автоматика больше не переподключается.
     */
    markSessionDead(reason) {
        if (this.sessionDead)
            return;
        this.sessionDead = true;
        this.sessionDeadReason = reason;
        this.connected = false;
        this.lastError = `${SESSION_DEAD_ERROR} (${reason})`;
        this.lastConnectError = this.lastError;
        console.error(`[mcp-telegram] FATAL ${reason}: сессия Telegram отозвана. Автоподключение остановлено, нужен telegram-login.`);
        const dying = this.client;
        this.client = null;
        if (dying) {
            dying._fisSealed = true;  // Telegram MCP Starter (A11): мёртвая сессия не оживает
            dying.destroy().catch(() => { });
        }
    }
    /** Telegram MCP Starter (A7): шаги 1с → 5с → 30с → 5мин вместо ретрая на каждом вызове. */
    bumpReconnectBackoff() {
        const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
        this.nextConnectAllowedAt = Date.now() + RECONNECT_BACKOFF_MS[idx];
        this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, RECONNECT_BACKOFF_MS.length - 1);
    }
    /** Telegram MCP Starter (A7): ловим отзыв ключа, случившийся УЖЕ ПОСЛЕ успешного коннекта. */
    installFatalErrorHandler(client) {
        client.onError = async (err) => {
            const e = err;
            const msg = e?.errorMessage || e?.message || String(err);
            const code = typeof e?.code === "number" ? e.code : undefined;
            if (isFatalAuthError(msg, code)) {
                this.markSessionDead(msg || (code ? `RPC ${code}` : "session revoked"));
                return;
            }
            console.error(`[mcp-telegram] client error: ${msg}`);
        };
        // Telegram MCP Starter (A7-tp, R4b): teleproto доводит до onError не всё, что доводил gramJS.
        // 1) На транспортный -404 / «invalid auth key» главного DC teleproto стирает ключ
        //    (он общий у соединения, dcenter и сессии) и зовёт _authKeyCallback(undefined),
        //    а затем reconnect() — с пустым ключом это новый DH, то есть демон жил бы
        //    неавторизованным. Разовый -404 бывает и на работах Telegram, поэтому не хороним
        //    сразу: возвращаем в тот же объект ключ из строки сессии на диске (DH идёт только
        //    при пустом ключе, MTProtoSender._connect), ждём паузу и после переподключения
        //    пробуем getMe. Смерть — по подтверждению: фатальная ошибка на пробе (ловит
        //    обёртка invoke ниже) или третий сброс за 10 минут. Если teleproto всё же выпустил
        //    новый ключ главного DC — сессия мертва сразу. Файл сессии не трогается.
        // 2) _handleReconnect не отдаёт onError ошибки 401 — ловим их в invoke главного DC
        //    (getMe пробы идёт через него же), только точным именем ошибки.
        if (fisTeleproto()) {
            const origKeyCb = client._authKeyCallback?.bind(client);
            if (origKeyCb) {
                client._authKeyCallback = async (authKey, dcId) => {
                    if (this.client !== client || dcId !== client.session?.dcId)
                        return origKeyCb(authKey, dcId);
                    const saved = await fisSavedKey(this.sessionString);
                    if (authKey) {
                        const got = authKey.getKey?.();
                        if (saved && got && !Buffer.from(got).equals(Buffer.from(saved))) {
                            this.markSessionDead(`AUTH_KEY_REKEYED dc${dcId}: библиотека выпустила новый ключ`);
                            return;
                        }
                        return origKeyCb(authKey, dcId);
                    }
                    const now = Date.now();
                    this.fisKeyResets = (this.fisKeyResets ?? []).filter((t) => now - t < 600000);
                    this.fisKeyResets.push(now);
                    const k = this.fisKeyResets.length;
                    const holder = client.session?.getAuthKey?.(dcId) ?? client._sender?.authKey;
                    if (!saved || !holder || k > 2) {
                        this.markSessionDead(`AUTH_KEY_RESET dc${dcId} ×${k} за 10 мин: сервер не узнал ключ`);
                        return;
                    }
                    await holder.setKey(saved);
                    const pause = fisEnvInt("TELEGRAM_KEY_RESET_PAUSE_MS", 5000) * (k === 1 ? 1 : 6);
                    console.error(`[mcp-telegram] AUTH_KEY_RESET dc${dcId}: сервер не узнал ключ — попытка ${k}/2 тем же ключом через ${pause} мс, затем проба getMe`);
                    await fisSleep(pause);
                    if (this.client !== client || this.sessionDead)
                        return;
                    const probe = setTimeout(() => {
                        if (this.client === client && !this.sessionDead)
                            client.getMe().catch(() => { });
                    }, fisEnvInt("TELEGRAM_KEY_PROBE_MS", 15000));
                    probe.unref?.();
                };
            }
            const origInvoke = client.invoke.bind(client);
            client.invoke = async (request, dcId, ...rest) => {
                try {
                    return await origInvoke(request, dcId, ...rest);
                }
                catch (err) {
                    const name = fisFatalAuthName(err);
                    if (name && dcId === undefined && this.client === client)
                        this.markSessionDead(name);
                    throw err;
                }
            };
        }
    }
    async clearSession() {
        // Destroy, never just drop the reference: an orphaned GramJS client keeps its update
        // loop and auto-reconnect running with nobody left to stop it.
        await this.dropDeadClient();
        this.sessionString = "";
        if (existsSync(this.sessionPath)) {
            await unlink(this.sessionPath);
        }
    }
    /** Ensure connection is active, auto-reconnect if session exists */
    async ensureConnected() {
        if (this.connected && this.client && !this.isTransportDead()) {
            return true;
        }
        // Not connected, or connected-by-flag only with a dead sender underneath.
        // connect() drops the stale client and rebuilds from the saved session.
        return this.connect();
    }
    async disconnect() {
        // Tear the client down whatever the flag says. It used to require `this.connected`,
        // but markUnhealthy() and a stale transport both clear the flag while leaving the
        // client (and its update loop) alive, so disconnecting such a service leaked it.
        await this.dropDeadClient();
    }
    /**
     * Terminates the session on Telegram servers, destroys the client, and clears
     * local session (in-memory + file). Returns true only when server-side revoke
     * confirmed. False means server revoke could not be confirmed — local wipe
     * was still attempted. Throws if local file removal failed so callers can
     * surface the partial state instead of silently misreporting success.
     */
    async logOut() {
        const wipeLocalOrThrow = async () => {
            await this.clearSession();
            if (existsSync(this.sessionPath)) {
                throw new Error(`Local session file still present after clearSession: ${this.sessionPath}`);
            }
        };
        if (!this.client || !this.connected) {
            if (existsSync(this.sessionPath))
                await wipeLocalOrThrow();
            return false;
        }
        const client = this.client;
        let revoked = false;
        try {
            await client.invoke(new Api.auth.LogOut());
            revoked = true;
        }
        catch (error) {
            console.error("[telegram] auth.LogOut failed:", error);
        }
        // destroy() failure must NOT mask a successful server revoke — log and continue.
        try {
            await client.destroy();
        }
        catch (err) {
            console.error("[telegram] client.destroy failed during logOut:", err);
        }
        // Already destroyed above — detach it so clearSession() does not destroy it twice.
        this.client = null;
        await wipeLocalOrThrow();
        return revoked;
    }
    isConnected() {
        return this.connected && !this.isTransportDead();
    }
    /**
     * Telegram MCP Starter (A1). Тот же дефект, что и в connect(): проверка состояния и создание
     * new TelegramClient разделены await'ами, поэтому два параллельных QR-логина поднимали
     * два клиента. Держим in-flight флаг и дожидаемся незавершённого connect(), чтобы логин
     * не стартовал поверх наполовину поднятого соединения.
     */
    async startQrLogin(onQrDataUrl, onQrUrl, signal) {
        if (this.qrLoginInFlight) {
            return { success: false, message: "QR login already in progress" };
        }
        if (this.connecting) {
            await this.connecting.catch(() => { });
        }
        this.qrLoginInFlight = true;
        try {
            return await this.startQrLoginOnce(onQrDataUrl, onQrUrl, signal);
        }
        finally {
            this.qrLoginInFlight = false;
        }
    }
    async startQrLoginOnce(onQrDataUrl, onQrUrl, signal) {
        // Early exit if already aborted — avoids creating a Telegram connection we'd immediately tear down.
        if (signal?.aborted)
            return { success: false, message: "QR login aborted" };
        const session = new StringSession("");
        const proxy = resolveProxy();
        const client = new TelegramClient(session, this.apiId, this.apiHash, {
            connectionRetries: 5,
            ...fisClientOptions(resolveUseWSS(proxy), session),  // Telegram MCP Starter (R4b)
            baseLogger: resolveBaseLogger(),  // апстрим 1.41.2: логгер библиотеки не выше ERROR
            ...(proxy && { proxy }),
        });
        try {
            await client.connect();
            if (signal?.aborted) {
                try {
                    await client.destroy();
                }
                catch {
                    // Abort path: the caller cancelled during connect, so teardown is best-effort.
                }
                return { success: false, message: "QR login aborted" };
            }
            let loginAccepted = false;
            let resolved = false;
            let lastQrUrl = "";
            client.addEventHandler((update) => {
                if (update instanceof Api.UpdateLoginToken) {
                    loginAccepted = true;
                }
            });
            const maxAttempts = 30; // 5 minutes
            for (let i = 0; i < maxAttempts && !resolved; i++) {
                if (signal?.aborted)
                    break;
                try {
                    const result = await client.invoke(new Api.auth.ExportLoginToken({
                        apiId: this.apiId,
                        apiHash: this.apiHash,
                        exceptIds: [],
                    }));
                    if (result instanceof Api.auth.LoginToken) {
                        const base64url = Buffer.from(result.token).toString("base64url");
                        const url = `tg://login?token=${base64url}`;
                        if (url !== lastQrUrl) {
                            lastQrUrl = url;
                            const dataUrl = await QRCode.toDataURL(url, {
                                width: 256,
                                margin: 2,
                            });
                            onQrDataUrl(dataUrl);
                            onQrUrl?.(url);
                        }
                    }
                    else if (result instanceof Api.auth.LoginTokenMigrateTo) {
                        await client._switchDC(result.dcId);
                        const imported = await client.invoke(new Api.auth.ImportLoginToken({ token:
                    result.token }));
                        if (imported instanceof Api.auth.LoginTokenSuccess) {
                            resolved = true;
                            break;
                        }
                    }
                    else if (result instanceof Api.auth.LoginTokenSuccess) {
                        resolved = true;
                        break;
                    }
                }
                catch (err) {
                    const error = err;
                    if (error.errorMessage === "SESSION_PASSWORD_NEEDED") {
                        // The QR was scanned, but the account has two-step verification.
                        // Complete the login with an SRP password check if we have the
                        // cloud password; otherwise tell the user how to provide it.
                        const outcome = await completeTwoFactorLogin(client, resolveTwoFactorPassword());
                        if (outcome.ok) {
                            resolved = true;
                            break;
                        }
                        // destroy() (not disconnect()) to free the auth_key/socket, matching
                        // every other failure exit in this method — important in daemon mode
                        // where the process lives on across logins.
                        try {
                            await client.destroy();
                        }
                        catch {
                            // Failure exit: the login outcome is already decided, so teardown is best-effort.
                        }
                        return { success: false, message: outcome.message };
                    }
                }
                if (!resolved) {
                    // Abortable sleep — wakes immediately when caller cancels
                    const waitMs = loginAccepted ? 1500 : 10000;
                    await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            signal?.removeEventListener("abort", onAbort);
                            resolve();
                        }, waitMs);
                        const onAbort = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                        if (signal?.aborted)
                            onAbort();
                        else
                            signal?.addEventListener("abort", onAbort, { once: true });
                    });
                }
            }
            if (signal?.aborted && !resolved) {
                try {
                    await client.destroy();
                }
                catch {
                    // Abort path: teardown is best-effort, the abort result is returned regardless.
                }
                return { success: false, message: "QR login aborted" };
            }
            if (resolved) {
                const newSession = client.session.save();
                // Persist FIRST, adopt SECOND — so if file write fails, in-memory state still
                // matches whatever's on disk; saveSession is try/catch-safe for Docker etc.
                await this.saveSession(newSession);
                // Destroy the previous in-memory client to free its auth_key / socket.
                // Previously left dangling → accumulated orphan Telegram connections per relogin.
                const oldClient = this.client;
                this.client = client;
                this.connected = true;
                this.entityCache.clear();
                // Telegram MCP Starter (A7): успешный ручной вход снимает липкий флаг «сессия мертва»
                // и бэкофф — иначе после отзыва демон остался бы парализован навсегда.
                this.sessionDead = false;
                this.sessionDeadReason = "";
                this.lastConnectError = "";
                this.lastError = "";
                this.reconnectAttempt = 0;
                this.nextConnectAllowedAt = 0;
                this.installFatalErrorHandler(client);
                if (oldClient) {
                    oldClient.destroy().catch(() => { });
                }
                return { success: true, message: "Telegram login successful" };
            }
            await client.destroy();
            return { success: false, message: "QR login timeout" };
        }
        catch (err) {
            try {
                await client.destroy();
            }
            catch {
                // Teardown must not mask `err`, which is the error actually reported to the caller.
            }
            return { success: false, message: `Login failed: ${err.message}` };
        }
    }
    // ─── Messages ──────────────────────────────────────────────────────────────
    async getMe() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const me = await this.client.getMe();
        const user = me;
        return {
            id: user.id.toString(),
            username: user.username ?? undefined,
            firstName: user.firstName ?? undefined,
        };
    }
    async sendMessage(chatId, text, replyTo, parseMode, topicId, extra) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            // Telegram MCP Starter (R6): Rich-сообщение (слой 228) с пользовательского аккаунта —
            // сервер Telegram сам разбирает Markdown/HTML в блоки (заголовки, списки,
            // таблицы). teleproto: client.sendMessage({ richMessage: Rich.markdown|html }).
            // Только текст, без parseMode/quoteText/effect: классические сущности и Rich —
            // разные вещи, смешивать их Telegram не даёт. На gramJS — внятный отказ.
            if (extra?.rich) {
                if (parseMode || extra.quoteText || extra.effect)
                    throw new Error("rich cannot be combined with parseMode, quoteText or effect");
                const tp = fisTeleproto();
                if (!tp?.rich)
                    throw new Error("Rich messages need teleproto (R4-lib): the installed MTProto library does not support them");
                const richMessage = extra.rich === "html" ? tp.rich.html(text) : tp.rich.markdown(text);
                return await client.sendMessage(resolved, {
                    richMessage,
                    ...(topicId ? { topMsgId: topicId } : {}),
                    ...(replyTo ? { replyTo } : {}),
                });
            }
            // Raw path: high-level client.sendMessage does not support quoteText/effect.
            // Fall back to messages.SendMessage when either is requested.
            if (extra?.quoteText || extra?.effect) {
                if (extra.quoteText && !replyTo) {
                    throw new Error("quoteText requires replyTo — provide the message ID of the message you are quoting");
                }
                const replyToObj = extra.quoteText
                    ? new Api.InputReplyToMessage({
                        replyToMsgId: replyTo,
                        topMsgId: topicId,
                        quoteText: extra.quoteText,
                    })
                    : buildReplyTo(replyTo, topicId);
                // GramJS parses md/html via the internal `_parseMessageText` helper. We feature-detect
                // it so a future GramJS rename surfaces a clear error instead of silently sending plain.
                let parsedText = text;
                let entities;
                if (parseMode) {
                    // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                    const parser = client._parseMessageText;
                    if (typeof parser !== "function") {
                        throw new Error("GramJS version incompatible: parseMode not supported in quoteText/effect code path. Omit parseMode or upgrade GramJS.");
                    }
                    [parsedText, entities] = await parser.call(client, text, parseMode === "html" ? "html" : "md");
                }
                const result = await client.invoke(new Api.messages.SendMessage({
                    peer: resolved,
                    message: parsedText,
                    randomId: generateRandomBigInt(),
                    ...(replyToObj ? { replyTo: replyToObj } : {}),
                    ...(entities?.length ? { entities } : {}),
                    ...(extra.effect ? { effect: bigInt(extra.effect) } : {}),
                }));
                const id = extractMessageId(result);
                if (id === undefined)
                    throw new Error("Telegram did not return a message ID for sendMessage");
                // Return a minimal UpdateShortSentMessage — it only carries `id`, avoiding fake peerId/date.
                return new Api.UpdateShortSentMessage({ id, pts: 0, ptsCount: 0, date: Math.floor(Date.now() / 1000) });
            }
            if (topicId) {
                return await client.sendMessage(resolved, {
                    message: text,
                    topMsgId: topicId,
                    ...(replyTo ? { replyTo } : {}),
                    ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
                });
            }
            return await client.sendMessage(resolved, {
                message: text,
                ...(replyTo ? { replyTo } : {}),
                ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
            });
        }, `sendMessage to ${chatId}`);
    }
    // Telegram MCP Starter (M11): asDocument=true шлёт видео ДОКУМЕНТОМ (без пережатия
    // Telegram, для перепостинга оригинала) — gramJS forceDocument.
    // Preserve both explicit topic routing and reply targets for uploaded files.
    async sendFile(chatId, filePath, caption, onProgress, asDocument, replyTo, topicId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // Telegram MCP Starter (M10): не оборачиваем большой upload общим retry
        // RateLimiter. Если SendMedia принят, а ответ потерян, повтор всей операции
        // создаст дубль; если оборвалась передача частей, повтор гигабайтного файла
        // внутри daemon идёт незаметно для клиента. Повтор разрешён только после
        // внешнего read-back/reconciliation.
        const canonicalPath = realpathSync(filePath);
        const resolved = await this.resolvePeer(chatId);
        const inputPeer = await client.getInputEntity(resolved);
        const canonicalTarget = fisInputPeerKey(inputPeer);
        const uploadKey = `${canonicalTarget}\u0000${canonicalPath}`;
        if (this.uploadsInFlight.has(uploadKey))
            throw new Error(`UPLOAD_IN_PROGRESS: ${canonicalPath} is already being uploaded to ${canonicalTarget}`);
        this.uploadsInFlight.add(uploadKey);
        try {
            const video = fisProbeVideo(canonicalPath);
            let lastProgressAt = 0;
            const progressCallback = typeof onProgress === "function"
                ? (uploaded, total) => {
                    const now = Date.now();
                    if (now - lastProgressAt < 1000)
                        return;
                    lastProgressAt = now;
                    const current = Number(typeof uploaded === "object" ? uploaded.toString() : uploaded);
                    const maximum = total == null ? undefined : Number(typeof total === "object" ? total.toString() : total);
                    // GramJS uploadFile передаёт не байты, а долю 0..1 одним
                    // аргументом. Нормализуем её в пару progress/total, чтобы
                    // клиент видел настоящий процент и продлевал timeout.
                    if (maximum === undefined && Number.isFinite(current) && current >= 0 && current <= 1)
                        onProgress(current, 1);
                    else
                        onProgress(Number.isFinite(current) ? current : 0, Number.isFinite(maximum) ? maximum : undefined);
                }
                : undefined;
            const attributes = (video && !asDocument)
                ? [new Api.DocumentAttributeVideo({
                    duration: video.duration,
                    w: video.width,
                    h: video.height,
                    supportsStreaming: true,
                })]
                : undefined;
            const message = await client.sendFile(inputPeer, {
                file: canonicalPath,
                caption,
                // В форуме ответ на сообщение темы Telegram сам кладёт в ту же
                // тему; topicId — прямое указание, когда отвечать не на что.
                ...(replyTo ? { replyTo } : (topicId ? { replyTo: topicId } : {})),
                // topMsgId preserves the selected forum topic even when replyTo is set.
                ...(topicId ? { topMsgId: topicId } : {}),
                ...(asDocument ? { forceDocument: true } : {}),
                // Caption у media message намеренно plain. Полный форматированный
                // текст отправляется отдельным HTML-ответом на messageId.
                parseMode: false,
                ...((video && !asDocument) ? { attributes, supportsStreaming: true } : {}),
                ...(progressCallback ? { progressCallback } : {}),
                // Большие записи эфиров состоят из тысяч 512-КБ частей. Один worker
                // превращал upload 1.5 ГБ в часовой; четыре дают умеренный параллелизм.
                ...(video ? { workers: 4 } : {}),
            });
            return {
                id: message.id,
                messageId: message.id,
                type: (video && !asDocument) ? "video" : "file",
                size: statSync(canonicalPath).size,
                ...(video ? { ...video, supportsStreaming: true } : {}),
            };
        }
        finally {
            this.uploadsInFlight.delete(uploadKey);
        }
    }
    async sendVoice(chatId, filePath, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const file = opts.fileName ? new CustomFile(opts.fileName, (await stat(filePath)).size, filePath) : filePath;
            // Duration is intentionally auto-detected by GramJS from the audio file —
            // letting the AI override it would mis-report playback length in the Telegram UI.
            const message = await client.sendFile(resolved, {
                file,
                voiceNote: true,
                caption: opts.caption,
                parseMode: opts.parseMode,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
            });
            return { id: message.id };
        }, `sendVoice to ${chatId}`);
    }
    async sendVideoNote(chatId, filePath, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const attributes = opts.duration || opts.length
                ? [
                    new Api.DocumentAttributeVideo({
                        roundMessage: true,
                        duration: opts.duration ?? 0,
                        w: opts.length ?? 0,
                        h: opts.length ?? 0,
                    }),
                ]
                : undefined;
            const message = await client.sendFile(resolved, {
                file: filePath,
                videoNote: true,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
                ...(attributes ? { attributes } : {}),
            });
            return { id: message.id };
        }, `sendVideoNote to ${chatId}`);
    }
    async sendContact(chatId, phone, firstName, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const media = new Api.InputMediaContact({
                phoneNumber: phone,
                firstName,
                lastName: opts.lastName ?? "",
                vcard: opts.vcard ?? "",
            });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendContact");
            return { id };
        }, `sendContact to ${chatId}`);
    }
    async sendDice(chatId, emoji, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media: new Api.InputMediaDice({ emoticon: emoji }),
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const dice = extractDiceResult(result);
            if (!dice) {
                const id = extractMessageId(result);
                if (id === undefined)
                    throw new Error("Telegram did not return a message ID for sendDice");
                return { id };
            }
            return dice;
        }, `sendDice to ${chatId}`);
    }
    async sendLocation(chatId, latitude, longitude, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const geoPoint = new Api.InputGeoPoint({
                lat: latitude,
                long: longitude,
                ...(opts.accuracyRadius !== undefined ? { accuracyRadius: opts.accuracyRadius } : {}),
            });
            const media = opts.livePeriod
                ? new Api.InputMediaGeoLive({
                    geoPoint,
                    period: opts.livePeriod,
                    ...(opts.heading !== undefined ? { heading: opts.heading } : {}),
                    ...(opts.proximityRadius !== undefined ? { proximityNotificationRadius: opts.proximityRadius } : {}),
                })
                : new Api.InputMediaGeoPoint({ geoPoint });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendLocation");
            return { id };
        }, `sendLocation to ${chatId}`);
    }
    async sendVenue(chatId, latitude, longitude, title, address, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const media = new Api.InputMediaVenue({
                geoPoint: new Api.InputGeoPoint({ lat: latitude, long: longitude }),
                title,
                address,
                provider: opts.provider ?? "foursquare",
                venueId: opts.venueId ?? "",
                venueType: opts.venueType ?? "",
            });
            const result = await client.invoke(new Api.messages.SendMedia({
                peer: resolved,
                media,
                message: "",
                randomId: generateRandomBigInt(),
                replyTo: buildReplyTo(opts.replyTo, opts.topicId),
            }));
            const id = extractMessageId(result);
            if (id === undefined)
                throw new Error("Telegram did not return a message ID for sendVenue");
            return { id };
        }, `sendVenue to ${chatId}`);
    }
    async sendAlbum(chatId, items, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        if (items.length < 2 || items.length > 10) {
            throw new Error("Album requires 2-10 items");
        }
        const client = this.client;
        // pi-lens-ignore: sql-injection
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            // Album-level caption lands on the first item; per-item captions stay as provided.
            const captions = items.map((it, i) => (i === 0 ? (opts.caption ?? it.caption ?? "") : (it.caption ?? "")));
            // Named items travel as CustomFile so Telegram gets the real name + MIME
            // instead of `basename(tempPath)`. forceDocument is pinned for the whole
            // album in that case: album members must be homogeneous, and extension-less
            // temp paths already went out as documents — naming them must not silently
            // promote images to compressed photos and break the grouping.
            const named = items.some((it) => it.fileName);
            const files = await Promise.all(items.map(async (it) => it.fileName ? new CustomFile(it.fileName, (await stat(it.filePath)).size, it.filePath) : it.filePath));
            // GramJS sendFile auto-detects `file: string[]` and takes the _sendAlbum path,
            // which invokes messages.UploadMedia per item + messages.SendMultiMedia.
            const result = (await client.sendFile(resolved, {
                file: files,
                caption: captions,
                ...(named ? { forceDocument: true } : {}),
                parseMode: opts.parseMode,
                ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
                ...(opts.topicId ? { topMsgId: opts.topicId } : {}),
            }));
            const ids = Array.isArray(result)
                ? result.filter((m) => m instanceof Api.Message).map((m) => m.id)
                : result instanceof Api.Message
                    ? [result.id]
                    : [];
            if (ids.length === 0)
                throw new Error("Telegram did not return any message IDs for sendAlbum");
            return { ids };
        }, `sendAlbum to ${chatId}`);
    }
    async downloadMedia(chatId, messageId, downloadPath, onProgress, richIndex) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const message = messages[0];
        if (!message)
            throw new Error(`Message ${messageId} not found`);
        // Telegram MCP Starter (R5): медиа Rich-сообщения лежат вне message.media —
        // в richMessage.photos/documents. richIndex — сквозной номер: сначала фото, потом
        // документы (как «медиа N» в строковом выводе и [rich-медиа i …] у каждого файла).
        // Скачивание дальше идёт тем же путём M7–M9-fix-2: свой поток, сверка размера
        // после close, уникальный .part с wx, FLOOD/AUTH/FILE_REFERENCE без повторов.
        let fisTarget = message;
        let fisSizeDoc = message.document;
        if (richIndex !== undefined && richIndex !== null) {
            const fisItem = await this.fisRichMediaItem(message, resolved, richIndex);
            fisTarget = fisItem.media;
            fisSizeDoc = fisItem.kind === "document" ? fisItem.media : undefined;
        }
        else if (!message.media)
            throw new Error(`Message ${messageId} has no media`);
        // Stream downloads to disk rather than buffering large media in memory.
        // Verify the final file size against Telegram metadata; a playable partial
        // file must not be reported as a complete download. Buffer-only callers
        // use the separate downloadMediaAsBuffer method.
        const fisExpectedSize = (() => {
            const doc = fisSizeDoc;  // Telegram MCP Starter (R5): у медиа Rich — документ блока
            const raw = doc && doc.size != null ? doc.size : null;
            if (raw == null)
                return null; // у фото единого размера нет, строгую сверку пропускаем
            const n = Number(typeof raw === "object" ? raw.toString() : raw);
            return Number.isFinite(n) && n > 0 ? n : null;
        })();
        // Telegram MCP Starter (M8): прогресс наверх, но не чаще раза в секунду — gramJS
        // дёргает колбэк на каждый кусок, а каждый вызов уходит сообщением по IPC.
        let fisLastProgressAt = 0;
        const fisProgress = typeof onProgress === "function"
            ? (received, total) => {
                const now = Date.now();
                if (now - fisLastProgressAt < 1000)
                    return;
                fisLastProgressAt = now;
                const r = Number(typeof received === "object" ? received.toString() : received);
                const t = total != null ? Number(typeof total === "object" ? total.toString() : total) : undefined;
                onProgress(Number.isFinite(r) ? r : 0, Number.isFinite(t) ? t : undefined);
            }
            : undefined;
        // Retry incomplete media transfers after the writer has closed. A write()
        // return value is not a promise: own the stream and await close before
        // checking size or publishing the final name.
        const FIS_ATTEMPTS = 3;
        // Exclusive, per-attempt temporary files prevent concurrent downloads
        // from overwriting or deleting each other's partial output.
        const fisPartName = () => `${downloadPath}.${process.pid}-${randomBytes(6).toString("hex")}.part`;
        // Ошибки, которые повтором через 2–4 секунды не лечатся, а вредят:
        // FLOOD_WAIT продлевает ожидание, AUTH_*/SESSION_* — мёртвая сессия,
        // FILE_REFERENCE_* требует заново получить сообщение. Пробрасываем сразу:
        // решает вызывающий (бэкофф докачки), а не три слепых повтора здесь.
        const fisFatal = (e) => {
            const code = e && (e.code ?? e.errorCode);
            const text = `${e && e.errorMessage ? e.errorMessage : ""} ${e && e.message ? e.message : ""}`;
            return code === 420 || code === 401
                || /FLOOD|AUTH_|SESSION_|FILE_REFERENCE_|A wait of \d+ seconds/.test(text);
        };
        let fisLastSize = 0;
        let fisLastError = null;
        for (let attempt = 1; attempt <= FIS_ATTEMPTS; attempt++) {
            fisLastProgressAt = 0; // троттлинг прогресса — свой на каждую попытку
            const fisPart = fisPartName();
            const fisWriter = createWriteStream(fisPart, { flags: "wx" });
            let fisStreamError = null;
            const fisClosed = new Promise((resolve) => fisWriter.once("close", resolve));
            fisWriter.on("error", (e) => { fisStreamError = e; });
            let result = null;
            fisLastError = null;
            try {
                result = await this.client.downloadMedia(fisTarget, {  // Telegram MCP Starter (R5)
                    outputFile: fisWriter,
                    ...(fisProgress ? { progressCallback: fisProgress } : {}),
                });
            }
            catch (e) {
                fisLastError = e;
            }
            finally {
                // gramJS закрывает поток сам, но на раннем выходе может и не
                // дойти до close — тогда закрываем мы. Ждём в любом случае.
                if (!fisWriter.writableEnded && !fisWriter.destroyed)
                    fisWriter.end();
                await fisClosed;
            }
            if (fisStreamError) {
                // Локальный сбой записи (ENOSPC, EACCES…) повтором не лечится:
                // текст с кодом ошибки докачка узнаёт и не списывает файл.
                try { unlinkSync(fisPart); } catch { }
                throw fisStreamError;
            }
            fisLastSize = existsSync(fisPart) ? statSync(fisPart).size : 0;
            const fisComplete = !fisLastError && result && fisLastSize > 0
                && (fisExpectedSize === null || fisLastSize === fisExpectedSize);
            if (fisComplete) {
                renameSync(fisPart, downloadPath);
                return downloadPath;
            }
            try { unlinkSync(fisPart); } catch { }
            if (fisLastError && fisFatal(fisLastError))
                throw fisLastError;
            // Ни ошибки, ни байта, а gramJS вернул пустоту или пустой Buffer — так
            // он отвечает на медиа без скачиваемого файла (веб-превью, гео, опрос).
            // Это свойство сообщения, а не связи: «нет файла» (permanent), а не
            // «файл пуст» — иначе докачка гоняла бы его бэкоффом вечно.
            if (!fisLastError && fisLastSize === 0 && fisExpectedSize === null
                && (result == null || (Buffer.isBuffer(result) && result.length === 0)))
                throw new Error(`Message ${messageId} has no media file to download (у сообщения нет файла)`);
            if (attempt < FIS_ATTEMPTS) {
                // Пауза растёт: соединению нужно время встать после обрыва.
                await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
        }
        if (fisLastError)
            throw fisLastError;
        if (fisLastSize === 0)
            throw new Error("Скачивание не удалось: файл пуст");
        throw new Error(`Скачивание оборвалось ${FIS_ATTEMPTS} раза подряд: в последней попытке получено ${fisLastSize} байт из ${fisExpectedSize}. Неполный файл удалён. Связь с Telegram нестабильна — попробуйте позже.`);
    }
    /** Telegram MCP Starter (R5): медиа Rich-сообщения по сквозному номеру (фото, затем документы).
     * Усечённое сервером сообщение (richMessage.part) сперва дотягивается тем же
     * fisRichFieldsFull (его пределы и лимитер): номер из прочитанного полного сообщения
     * должен указывать туда же. Не дотянулось, а номера в части нет — временный отказ
     * («неполное»): полное придёт следующим вызовом. Номера нет в полном — «нет файла».
     */
    async fisRichMediaItem(message, peer, richIndex) {
        const id = message?.id;
        if (!Number.isInteger(richIndex) || richIndex < 0)
            throw new Error(`richIndex must be a non-negative integer, got ${richIndex}`);
        if (!fisTeleproto() || message?.richMessage?.className !== "RichMessage")
            throw new Error(`Message ${id} has no media file to download (не Rich-сообщение: медиа Rich нет)`);
        if (message.richMessage.part)
            await this.fisRichFieldsFull(message, peer);
        const r = message.richMessage;
        const photos = r.photos ?? [];
        const docs = r.documents ?? [];
        const kind = richIndex < photos.length ? "photo" : richIndex < photos.length + docs.length ? "document" : null;
        const media = kind === "photo" ? photos[richIndex] : kind === "document" ? docs[richIndex - photos.length] : null;
        if (!kind) {
            if (r.part)
                throw new Error(`Rich message ${id} is partial: media #${richIndex} not received yet (неполное Rich-сообщение — повторите позже)`);
            throw new Error(`Message ${id} has no media file to download (медиа Rich #${richIndex} нет, всего ${photos.length + docs.length})`);
        }
        const ok = kind === "photo" ? media instanceof Api.Photo : media instanceof Api.Document;
        if (!ok)
            throw new Error(`Message ${id} has no media file to download (медиа Rich #${richIndex} пусто: ${media?.className ?? "нет"})`);
        return { kind, media };
    }
    /**
     * Download a message's media into memory.
     *
     * When `options.thumb` is given, GramJS fetches that thumbnail size instead of
     * the full file (`0` = smallest, larger indexes = bigger previews). This keeps
     * payloads tiny — useful for callers that inline the bytes and pay per byte
     * (e.g. base64 in an LLM context). If the message has no thumbnail at that
     * index, GramJS returns an empty/`undefined` buffer; we transparently fall
     * back to the full file so the caller always gets bytes. `isThumb` reports
     * which one was served.
     *
     * Note: GramJS signals "no bytes" inconsistently — `undefined` for a missing
     * thumbnail, but `Buffer.alloc(0)` for undownloadable media (geo/poll/dice,
     * documents without a file, and several failure paths). An empty Buffer is
     * truthy, so we guard on `.length`, not truthiness, in both the fallback and
     * the final failure check — otherwise a 0-byte buffer would be returned as a
     * "successful" (but garbage) download.
     */
    async downloadMediaAsBuffer(chatId, messageId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const message = messages[0];
        if (!message)
            throw new Error(`Message ${messageId} not found`);
        if (!message.media)
            throw new Error(`Message ${messageId} has no media`);
        let isThumb = false;
        let buffer;
        if (options?.thumb !== undefined) {
            buffer = (await this.client.downloadMedia(message, { thumb: options.thumb }));
            isThumb = !!buffer?.length;
        }
        // No thumb requested, or this media has no thumbnail at that size → full file.
        if (!buffer?.length)
            buffer = (await this.client.downloadMedia(message));
        if (!buffer?.length)
            throw new Error("Failed to download media");
        const mimeType = this.detectMimeType(buffer, message.media);
        return { buffer, mimeType, isThumb };
    }
    /** Detect MIME type from buffer magic bytes, falling back to media metadata */
    detectMimeType(buffer, media) {
        // Check magic bytes first
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
            return "image/jpeg";
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
            return "image/png";
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
            return "image/gif";
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50)
            return "image/webp";
        // Fall back to document mimeType
        const m = media;
        const doc = m.document;
        if (doc?.mimeType)
            return doc.mimeType;
        if (m.photo)
            return "image/jpeg";
        return "application/octet-stream";
    }
    async pinMessage(chatId, messageId, silent = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.pinMessage(resolved, messageId, { notify: !silent });
    }
    async unpinMessage(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.unpinMessage(resolved, messageId);
    }
    // ─── Dialogs ───────────────────────────────────────────────────────────────
    async getDialogs(limit = 20, offsetDate, filterType) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const fetchLimit = filterType ? limit * 3 : limit;
        const dialogs = await this.client.getDialogs({ limit: fetchLimit, ...(offsetDate ? { offsetDate } : {}) });
        const mapped = dialogs.map((d) => {
            const type = d.isGroup ? "group" : d.isChannel ? "channel" : "private";
            const isUser = d.entity instanceof Api.User;
            return {
                id: d.id?.toString() ?? "",
                name: d.title ?? d.name ?? "Unknown",
                type,
                unreadCount: d.unreadCount,
                ...(isUser
                    ? { isBot: Boolean(d.entity.bot), isContact: Boolean(d.entity.contact) }
                    : {}),
            };
        });
        if (filterType === "contact_requests") {
            return mapped.filter((d) => d.type === "private" && d.isContact === false).slice(0, limit);
        }
        return filterType ? mapped.filter((d) => d.type === filterType).slice(0, limit) : mapped;
    }
    async getUnreadDialogs(limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const dialogs = await this.client.getDialogs({ limit: limit * 3 });
        const unread = dialogs.filter((d) => d.unreadCount > 0).slice(0, limit);
        const results = await Promise.all(unread.map(async (d) => {
            const isUser = d.entity instanceof Api.User;
            const isForum = d.entity instanceof Api.Channel && Boolean(d.entity.forum);
            const base = {
                id: d.id?.toString() ?? "",
                name: d.title ?? d.name ?? "Unknown",
                type: d.isGroup ? "group" : d.isChannel ? "channel" : "private",
                unreadCount: d.unreadCount,
                ...(isUser
                    ? { isBot: Boolean(d.entity.bot), isContact: Boolean(d.entity.contact) }
                    : {}),
            };
            if (isForum) {
                try {
                    const forumTopics = await this.getForumTopics(d.id?.toString() ?? "");
                    const unreadTopics = forumTopics
                        .filter((t) => t.unreadCount > 0)
                        .map((t) => ({ id: t.id, title: t.title, unreadCount: t.unreadCount }));
                    const realUnread = unreadTopics.reduce((sum, t) => sum + t.unreadCount, 0);
                    if (realUnread === 0)
                        return null;
                    return {
                        ...base,
                        unreadCount: realUnread,
                        forum: true,
                        topics: unreadTopics.length > 0 ? unreadTopics : undefined,
                    };
                }
                catch {
                    return { ...base, forum: true };
                }
            }
            return base;
        }));
        return results.filter((r) => r !== null);
    }
    async getContactRequests(limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const dialogs = await this.client.getDialogs({ limit: limit * 5 });
        return dialogs
            .filter((d) => {
            if (d.isGroup || d.isChannel)
                return false;
            return d.entity instanceof Api.User && !d.entity.contact;
        })
            .slice(0, limit)
            .map((d) => {
            const user = d.entity;
            const msg = d.message;
            return {
                id: d.id?.toString() ?? "",
                name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown",
                username: user.username ?? undefined,
                isBot: Boolean(user.bot),
                unreadCount: d.unreadCount,
                lastMessage: (msg ? this.fisRichFields(msg).text : undefined) || undefined,  // Telegram MCP Starter (R4)
                lastMessageDate: msg?.date ?? undefined,
            };
        });
    }
    // ─── Contacts ──────────────────────────────────────────────────────────────
    async addContact(userId, firstName, lastName, phone) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.AddContact({
            id: entity,
            firstName,
            lastName: lastName ?? "",
            phone: phone ?? "",
        }));
    }
    async blockUser(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.Block({ id: entity }));
    }
    async reportSpam(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.client.getInputEntity(chatId);
        await this.client.invoke(new Api.messages.ReportSpam({ peer }));
    }
    // ─── Read state ────────────────────────────────────────────────────────────
    async markAsRead(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.markAsRead(chatId);
    }
    async getMessageById(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, { ids: [messageId] });
        const m = messages[0];
        if (!m || m.id !== messageId)
            return null;
        return {
            id: m.id,
            ...(await this.fisRichFieldsFull(m, resolved)),  // Telegram MCP Starter (R4)
            sender: await this.resolveSenderName(m.senderId, m.sender),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
        };
    }
    async forwardMessage(fromChatId, toChatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolvedFrom = await this.resolvePeer(fromChatId);
        const resolvedTo = await this.resolvePeer(toChatId);
        await this.client.forwardMessages(resolvedTo, { messages: messageIds, fromPeer: resolvedFrom });
    }
    async editMessage(chatId, messageId, newText) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        // pi-lens-ignore: sql-injection
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            await this.client?.editMessage(resolved, { message: messageId, text: newText });
        }, `editMessage ${messageId} in ${chatId}`);
    }
    async deleteMessages(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            await this.client?.deleteMessages(resolved, messageIds, { revoke: true });
        }, `deleteMessages in ${chatId}`);
    }
    // Telegram MCP Starter (M1): мини-приложения Telegram (Mini Apps / WebApps).
    // gramJS отдаёт для пользователя InputPeerUser, а методы webview требуют InputUser —
    // без этой конверсии Telegram отвечает невнятным CONSTRUCTOR_NOT_FOUND.
    fisToInputUser(inputPeer) {
        if (inputPeer instanceof Api.InputPeerSelf)
            return new Api.InputUserSelf();
        if (inputPeer instanceof Api.InputPeerUser)
            return new Api.InputUser({ userId: inputPeer.userId, accessHash: inputPeer.accessHash });
        throw new Error("Мини-приложения есть только у ботов и пользователей");
    }
    async fisResolveBotInput(bot) {
        const resolved = await this.resolvePeer(bot);
        const peer = await this.client?.getInputEntity(resolved);
        if (!peer)
            throw new Error(`Не удалось определить бота ${bot}`);
        return { peer, user: this.fisToInputUser(peer) };
    }
    // Telegram MCP Starter (M1)
    async listAttachMenuMiniApps() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const res = await this.client?.invoke(new Api.messages.GetAttachMenuBots({ hash: bigInt(0) }));
            const bots = res && "bots" in res ? res.bots : [];
            return bots.map((b) => ({
                botId: String(b.botId),
                shortName: b.shortName,
                inactive: Boolean(b.inactive),
                requestWriteAccess: Boolean(b.requestWriteAccess),
            }));
        });
    }
    // Telegram MCP Starter (M1)
    async getMiniAppInfo(bot, appName) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const { user } = await this.fisResolveBotInput(bot);
            const res = await this.client?.invoke(new Api.messages.GetBotApp({
                app: new Api.InputBotAppShortName({ botId: user, shortName: appName }),
                hash: bigInt(0),
            }));
            const app = res && "app" in res ? res.app : null;
            return {
                title: app?.title ?? appName,
                shortName: app?.shortName ?? appName,
                description: app?.description ?? "",
                inactive: Boolean(res?.inactive),
                requestWriteAccess: Boolean(res?.requestWriteAccess),
            };
        });
    }
    // Telegram MCP Starter (M1)
    async requestMiniAppUrl({ bot, appName, startParam, peer, platform = "web", writeAllowed = false }) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const { peer: botPeer, user } = await this.fisResolveBotInput(bot);
            const target = peer
                ? await this.client?.getInputEntity(await this.resolvePeer(peer))
                : botPeer;
            const result = appName
                ? await this.client?.invoke(new Api.messages.RequestAppWebView({
                    peer: target,
                    app: new Api.InputBotAppShortName({ botId: user, shortName: appName }),
                    platform,
                    startParam,
                    writeAllowed: writeAllowed ? true : undefined,
                }))
                : await this.client?.invoke(new Api.messages.RequestMainWebView({
                    peer: target,
                    bot: user,
                    platform,
                    startParam,
                }));
            if (!result || !("url" in result))
                throw new Error("Telegram не вернул ссылку мини-приложения");
            return { url: result.url, queryId: result.queryId ? String(result.queryId) : null };
        });
    }
    // Telegram MCP Starter (M1)
    async prolongMiniApp({ bot, peer, queryId }) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const { peer: botPeer, user } = await this.fisResolveBotInput(bot);
            const target = peer
                ? await this.client?.getInputEntity(await this.resolvePeer(peer))
                : botPeer;
            const res = await this.client?.invoke(new Api.messages.ProlongWebView({
                peer: target,
                bot: user,
                queryId: bigInt(queryId),
            }));
            return Boolean(res);
        });
    }
    async getScheduledMessages(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetScheduledHistory({ peer, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const messages = result
                .messages;
            return messages
                .filter((m) => m instanceof Api.Message)
                .map((m) => ({
                id: m.id,
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                ...this.fisRichFields(m),  // Telegram MCP Starter (R4)
                media: this.extractMediaInfo(m.media),
            }));
        }, `getScheduledMessages in ${chatId}`);
    }
    async deleteScheduledMessages(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.DeleteScheduledMessages({ peer, id: messageIds }));
        }, `deleteScheduledMessages in ${chatId}`);
    }
    async getReplies(chatId, messageId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetReplies({ peer, msgId: messageId, limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const messages = result
                .messages;
            return Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m, fisI, fisArr) => ({
                id: m.id,
                ...(await this.fisRichFieldsFull(m, peer, fisArr)),  // Telegram MCP Starter (R4)
                sender: await this.resolveSenderName(m.senderId, m.sender),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
                // Telegram MCP Starter: отдаём ПОЛНЫЙ набор параметров сообщения.
                // Раньше здесь терялись replyTo, пересылка, правка, entities — а
                // это жёсткие факты связи «ответ на вопрос», которые задним числом
                // из текстового архива уже не восстановить. Правило: сохраняем всё,
                // разбираться можно потом и сколько угодно раз.
                senderId: m.senderId ? String(m.senderId) : null,
                replyToMsgId: m.replyTo?.replyToMsgId ?? null,
                replyToTopId: m.replyTo?.replyToTopId ?? null,
                quoteText: m.replyTo?.quoteText ?? null,
                fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                    fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
                editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
                viaBotId: m.viaBotId ? String(m.viaBotId) : null,
                groupedId: m.groupedId ? String(m.groupedId) : null,
                views: m.views ?? null,
                forwards: m.forwards ?? null,
                postAuthor: m.postAuthor ?? null,
                pinned: m.pinned ?? false,
                entities: Array.isArray(m.entities) && m.entities.length
                    ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                    : null,
            })));
        }, `getReplies for ${messageId} in ${chatId}`);
    }
    async getMessageLink(chatId, messageId, thread = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Message links are only available for channels and supergroups");
            }
            const result = await this.client?.invoke(new Api.channels.ExportMessageLink({ channel: entity, id: messageId, thread }));
            if (!result)
                throw new Error("Failed to export message link");
            return result.link;
        }, `getMessageLink for ${messageId} in ${chatId}`);
    }
    async getUnreadMentions(chatId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetUnreadMentions({
                peer,
                offsetId: 0,
                addOffset: 0,
                limit,
                maxId: 0,
                minId: 0,
            }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const typedResult = result;
            const messages = typedResult.messages;
            const items = await Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m, fisI, fisArr) => ({
                id: m.id,
                ...(await this.fisRichFieldsFull(m, peer, fisArr)),  // Telegram MCP Starter (R4)
                sender: await this.resolveSenderName(m.senderId, m.sender),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
                // Telegram MCP Starter: отдаём ПОЛНЫЙ набор параметров сообщения.
                // Раньше здесь терялись replyTo, пересылка, правка, entities — а
                // это жёсткие факты связи «ответ на вопрос», которые задним числом
                // из текстового архива уже не восстановить. Правило: сохраняем всё,
                // разбираться можно потом и сколько угодно раз.
                senderId: m.senderId ? String(m.senderId) : null,
                replyToMsgId: m.replyTo?.replyToMsgId ?? null,
                replyToTopId: m.replyTo?.replyToTopId ?? null,
                quoteText: m.replyTo?.quoteText ?? null,
                fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                    fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
                editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
                viaBotId: m.viaBotId ? String(m.viaBotId) : null,
                groupedId: m.groupedId ? String(m.groupedId) : null,
                views: m.views ?? null,
                forwards: m.forwards ?? null,
                postAuthor: m.postAuthor ?? null,
                pinned: m.pinned ?? false,
                entities: Array.isArray(m.entities) && m.entities.length
                    ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                    : null,
            })));
            // Only mark all as read when we received the complete set; if truncated, marking all
            // would silently clear mentions the caller hasn't seen yet.
            const totalCount = "count" in typedResult ? typedResult.count : items.length;
            if (items.length > 0 && items.length >= totalCount) {
                try {
                    await this.client?.invoke(new Api.messages.ReadMentions({ peer }));
                }
                catch {
                    // best-effort; don't discard fetched items on mark-read failure
                }
            }
            return items;
        }, `getUnreadMentions in ${chatId}`);
    }
    async getUnreadReactions(chatId, limit = 20) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.GetUnreadReactions({
                peer,
                offsetId: 0,
                addOffset: 0,
                limit,
                maxId: 0,
                minId: 0,
            }));
            if (!result || result instanceof Api.messages.MessagesNotModified)
                return [];
            const typedResult = result;
            const messages = typedResult.messages;
            const items = await Promise.all(messages
                .filter((m) => m instanceof Api.Message)
                .map(async (m, fisI, fisArr) => ({
                id: m.id,
                ...(await this.fisRichFieldsFull(m, peer, fisArr)),  // Telegram MCP Starter (R4)
                sender: await this.resolveSenderName(m.senderId, m.sender),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
                // Telegram MCP Starter: отдаём ПОЛНЫЙ набор параметров сообщения.
                // Раньше здесь терялись replyTo, пересылка, правка, entities — а
                // это жёсткие факты связи «ответ на вопрос», которые задним числом
                // из текстового архива уже не восстановить. Правило: сохраняем всё,
                // разбираться можно потом и сколько угодно раз.
                senderId: m.senderId ? String(m.senderId) : null,
                replyToMsgId: m.replyTo?.replyToMsgId ?? null,
                replyToTopId: m.replyTo?.replyToTopId ?? null,
                quoteText: m.replyTo?.quoteText ?? null,
                fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                    fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
                editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
                viaBotId: m.viaBotId ? String(m.viaBotId) : null,
                groupedId: m.groupedId ? String(m.groupedId) : null,
                views: m.views ?? null,
                forwards: m.forwards ?? null,
                postAuthor: m.postAuthor ?? null,
                pinned: m.pinned ?? false,
                entities: Array.isArray(m.entities) && m.entities.length
                    ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                    : null,
            })));
            // Only mark all as read when we received the complete set; if truncated, marking all
            // would silently clear reactions the caller hasn't seen yet.
            const totalCount = "count" in typedResult ? typedResult.count : items.length;
            if (items.length > 0 && items.length >= totalCount) {
                try {
                    await this.client?.invoke(new Api.messages.ReadReactions({ peer }));
                }
                catch {
                    // best-effort; don't discard fetched items on mark-read failure
                }
            }
            return items;
        }, `getUnreadReactions in ${chatId}`);
    }
    async translateText(chatId, messageIds, toLang) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const result = await this.client?.invoke(new Api.messages.TranslateText({ peer, id: messageIds, toLang }));
            if (!result)
                return [];
            return result.result.map((t) => (t instanceof Api.TextWithEntities ? t.text : ""));
        }, `translateText in ${chatId}`);
    }
    async sendTyping(chatId, action = "typing") {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            let stamped = false;
            if (action !== "cancel") {
                const now = Date.now();
                const last = this.lastTypingAt.get(chatId) ?? 0;
                if (now - last < 10_000)
                    return;
                this.lastTypingAt.set(chatId, now);
                stamped = true;
            }
            try {
                const resolved = await this.resolvePeer(chatId);
                const peer = await this.client?.getInputEntity(resolved);
                if (!peer)
                    throw new Error(`Cannot resolve peer for ${chatId}`);
                let sendAction;
                switch (action) {
                    case "cancel":
                        sendAction = new Api.SendMessageCancelAction();
                        break;
                    case "upload_photo":
                        sendAction = new Api.SendMessageUploadPhotoAction({ progress: 0 });
                        break;
                    case "upload_document":
                        sendAction = new Api.SendMessageUploadDocumentAction({ progress: 0 });
                        break;
                    default:
                        sendAction = new Api.SendMessageTypingAction();
                }
                await this.client?.invoke(new Api.messages.SetTyping({ peer, action: sendAction }));
                if (action === "cancel") {
                    this.lastTypingAt.delete(chatId);
                }
            }
            catch (err) {
                if (stamped)
                    this.lastTypingAt.delete(chatId);
                throw err;
            }
        }, `sendTyping in ${chatId}`);
    }
    // ─── Chat lookup & info ────────────────────────────────────────────────────
    /**
     * Resolve a chat by ID, username, or display name.
     * Falls back to searching user's dialogs if getEntity() fails.
     */
    async resolveChat(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const cached = this.entityCache.get(chatId);
        if (cached)
            return cached;
        // First try direct resolve (numeric ID, username, phone)
        try {
            const entity = await this.client.getEntity(chatId);
            this.entityCache.set(chatId, entity);
            return entity;
        }
        catch {
            // Fall through to dialog search
        }
        // Search dialogs by display name
        const dialogs = await this.client.getDialogs({ limit: 100 });
        const query = chatId.toLowerCase();
        // Exact match first
        const exact = dialogs.find((d) => d.title?.toLowerCase() === query);
        if (exact?.entity) {
            this.entityCache.set(chatId, exact.entity);
            return exact.entity;
        }
        // Partial match
        const partial = dialogs.filter((d) => d.title?.toLowerCase().includes(query));
        if (partial.length === 1 && partial[0].entity) {
            this.entityCache.set(chatId, partial[0].entity);
            return partial[0].entity;
        }
        if (partial.length > 1) {
            const matches = partial.map((d) => `  ${d.title} (${d.entity?.id?.toString() ?? "?"})`).join("\n");
            throw new Error(`Multiple chats match "${chatId}". Use the numeric ID instead:\n${matches}`);
        }
        throw new Error(`Cannot find chat "${chatId}". Use a numeric ID, @username, or run telegram-search-chats to find it.`);
    }
    /**
     * Resolve chatId to a peer string that GramJS methods accept.
     * Handles display names by searching dialogs.
     */
    async resolvePeer(chatId) {
        // Normalize Saved Messages aliases — GramJS intercepts only plain `me`.
        if (["me", "@me", "self", "@self"].includes(chatId.trim().toLowerCase()))
            return "me";
        // @usernames resolve directly via contacts.ResolveUsername
        if (chatId.startsWith("@"))
            return chatId;
        // Bare numeric IDs need an entity with access_hash. GramJS can build an
        // InputPeer from a raw number only if it's already cached or the account
        // is a contact / has messaged us — otherwise getInputEntity throws
        // "Could not find the input entity". A bare positive number is also
        // ambiguous (GramJS assumes PeerUser, so channel IDs fail outright).
        // Recover by looking the ID up among dialogs, which yields a full entity
        // (with access_hash) for both users and channels.
        if (/^-?\d+$/.test(chatId))
            return this.resolveNumericPeer(chatId);
        // Everything else — resolve display name via dialogs
        return this.resolveChat(chatId);
    }
    /**
     * Resolve a bare numeric ID to a cached/dialog entity so GramJS can build a
     * valid InputPeer. Falls back to the raw ID string if no dialog matches —
     * GramJS may still resolve it (e.g. a contact or a peer it has messaged),
     * and we must not regress that path.
     */
    async resolveNumericPeer(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const cached = this.entityCache.get(chatId);
        if (cached)
            return cached;
        // Direct resolve first — succeeds when GramJS already knows the peer.
        try {
            const entity = await this.client.getEntity(chatId);
            this.entityCache.set(chatId, entity);
            return entity;
        }
        catch {
            // Fall through to dialog scan.
        }
        // Scan dialogs for a matching entity. Marked negative chat IDs carry peer
        // type information; compare their full form to avoid matching a basic group
        // to a user with the same bare ID.
        const isMarked = chatId.startsWith("-");
        try {
            const dialogs = await this.client.getDialogs({ limit: 100 });
            const match = dialogs.find((d) => {
                const entity = d.entity;
                if (!entity?.id)
                    return false;
                const bare = entity.id.toString();
                if (!isMarked)
                    return chatId === bare;
                // Marked input must match the entity's marked form.
                if (entity instanceof Api.Channel)
                    return chatId === `-100${bare}`;
                if (entity instanceof Api.Chat)
                    return chatId === `-${bare}`;
                return false;
            });
            if (match?.entity) {
                this.entityCache.set(chatId, match.entity);
                return match.entity;
            }
        }
        catch {
            // Dialog fetch failed — fall back to the raw ID below.
        }
        // Last resort: hand the raw ID to GramJS and let it try GetUsers/GetChannels.
        return chatId;
    }
    async getChatInfo(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.User) {
            const parts = [entity.firstName, entity.lastName].filter(Boolean);
            return {
                id: entity.id.toString(),
                name: parts.join(" ") || "Unknown",
                type: "private",
                username: entity.username ?? undefined,
                isBot: Boolean(entity.bot),
                isContact: Boolean(entity.contact),
            };
        }
        if (entity instanceof Api.Channel) {
            let membersCount = entity.participantsCount ?? undefined;
            let description;
            try {
                const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                if (full.fullChat instanceof Api.ChannelFull) {
                    membersCount = membersCount ?? full.fullChat.participantsCount ?? undefined;
                    description = full.fullChat.about || undefined;
                }
            }
            catch {
                // May fail for some channels — fall back to basic info
            }
            return {
                id: entity.id.toString(),
                name: entity.title,
                type: entity.megagroup ? "group" : "channel",
                username: entity.username ?? undefined,
                description,
                membersCount,
                forum: Boolean(entity.forum) || undefined,
            };
        }
        if (entity instanceof Api.Chat) {
            let membersCount = entity.participantsCount ?? undefined;
            let description;
            try {
                const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                if (full.fullChat instanceof Api.ChatFull) {
                    if (!membersCount && full.fullChat.participants instanceof Api.ChatParticipants) {
                        membersCount = full.fullChat.participants.participants.length;
                    }
                    description = full.fullChat.about || undefined;
                }
            }
            catch {
                // Fall back to basic info
            }
            return {
                id: entity.id.toString(),
                name: entity.title,
                type: "group",
                description,
                membersCount,
            };
        }
        return { id: chatId, name: "Unknown", type: "unknown" };
    }
    /** Extract media info from a message */
    /** Telegram MCP Starter (R4): поля текста сообщения с учётом Rich.
     *
     * Обычное сообщение — { text } как было. Rich — text = markdown блоков (ссылки
     * сохраняются как [текст](url)), rich: true, richBlocks — сами блоки (для raw),
     * richMentions — упоминания с userId (в markdown их id теряется), richMedia —
     * фото/документы блоков по id. richPartial — сервер прислал часть, а дотянуть
     * messages.getRichMessage не удалось (или вызвано без сети).
     */
    fisRichFields(m) {
        const tp = fisTeleproto();
        const r = m?.richMessage;
        if (!tp || !r || r.className !== "RichMessage")
            return { text: m?.message ?? "" };
        let text;
        try {
            text = tp.rich.toMarkdown(r);
        }
        catch {
            try {
                text = tp.rich.toPlainText(r);
            }
            catch {
                text = "";
            }
        }
        if (!text && m.message)
            text = m.message;
        const docs = (r.documents ?? []).map((d) => {
            let fileName = null;
            for (const a of d?.attributes ?? [])
                if (a?.className === "DocumentAttributeFilename")
                    fileName = a.fileName;
            return { id: d?.id !== undefined ? String(d.id) : null, mimeType: d?.mimeType ?? null, fileName,
                size: d?.size !== undefined && d?.size !== null ? Number(d.size.toString()) : null };
        });
        const mentions = fisRichMentions(r);
        return {
            text,
            rich: true,
            ...(r.part ? { richPartial: true } : {}),
            ...(mentions.length ? { richMentions: mentions } : {}),
            // Telegram MCP Starter (R4b): index — позиция в richMessage.photos/documents: по нему
            // докачка найдёт файл в том же сообщении (id + messageId + index).
            ...(r.photos?.length || docs.length ? { richMedia: {
                    photos: (r.photos ?? []).map((p, index) => ({ id: p?.id !== undefined ? String(p.id) : null, index })),
                    documents: docs.map((d, index) => ({ ...d, index })),
                } } : {}),
            richBlocks: fisTlToJson(r.blocks ?? []),
        };
    }
    /** Telegram MCP Starter (R4, R4b): то же, но усечённое сервером (richMessage.part) дотягивает
     * messages.getRichMessage. Пределы: один вызов за раз на процесс (общий лимитер), вызов
     * не дольше TELEGRAM_RICH_CALL_MS (8 с), не больше TELEGRAM_RICH_MAX_PER_READ (10) на одно
     * чтение, чтение ждёт не дольше TELEGRAM_RICH_READ_MS (15 с) + один вызов — меньше
     * IPC-таймаута 30 с, и чужие чтения в очереди не держат дольше своего бюджета. Сверх
     * пределов и при ошибке — часть, richPartial: true и richError; чтение не падает.
     * peer — InputPeer; Peer из глобального поиска разрешается getInputEntity (кэш сущностей).
     * batch — массив, по которому идёт map одного чтения: по нему считается потолок.
     */
    async fisRichFieldsFull(m, peer, batch) {
        const r = m?.richMessage;
        if (!r || r.className !== "RichMessage" || !r.part || !this.client || !fisTeleproto())
            return this.fisRichFields(m);
        const partial = (why) => ({ ...this.fisRichFields(m), richPartial: true, richError: String(why).slice(0, 200) });
        let ctx = batch ? FIS_RICH_BATCH.get(batch) : undefined;
        if (!ctx) {
            ctx = { start: Date.now(), n: 0 };
            if (batch)
                FIS_RICH_BATCH.set(batch, ctx);
        }
        if (ctx.n >= fisRichMaxPerRead())
            return partial("потолок дотягиваний на одно чтение");
        ctx.n++;
        const client = this.client;
        const callMs = fisRichCallMs();
        const left = () => fisRichReadMs() - (Date.now() - ctx.start);
        const run = async () => {
            if (left() <= 0)
                throw new Error("бюджет чтения исчерпан");
            let input = peer;
            if (typeof input?.className === "string" && /^Peer(User|Chat|Channel)$/.test(input.className))
                input = await fisWithTimeout(client.getInputEntity(input), callMs, "getInputEntity");
            if (!input)
                throw new Error("нет peer для getRichMessage");
            const res = await fisWithTimeout(client.invoke(new Api.messages.GetRichMessage({ peer: input, id: m.id })), callMs, "getRichMessage");
            const full = (res?.messages ?? []).find((x) => x?.id === m.id);
            if (full?.richMessage?.className !== "RichMessage")
                throw new Error("сервер не вернул Rich");
            return full.richMessage;
        };
        const job = fisRichLimiter.then(run, run);
        fisRichLimiter = job.then(() => { }, () => { });
        try {
            m.richMessage = await fisWithTimeout(job, Math.max(0, left()) + callMs, "очередь getRichMessage");
            return this.fisRichFields(m);
        }
        catch (e) {
            return partial(e?.errorMessage ?? e?.message ?? e);
        }
    }
    // Telegram MCP Starter (R4b): пределы и доступ к Rich — см. fisRichFieldsFull
    extractMediaInfo(media) {
        if (!media)
            return undefined;
        if (media instanceof Api.MessageMediaPhoto) {
            return { type: "photo" };
        }
        if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
            const doc = media.document;
            let type = "document";
            let fileName;
            let video;
            for (const attr of doc.attributes) {
                if (attr instanceof Api.DocumentAttributeVideo) {
                    type = "video";
                    video = {
                        width: attr.w,
                        height: attr.h,
                        duration: attr.duration,
                        supportsStreaming: Boolean(attr.supportsStreaming),
                        roundMessage: Boolean(attr.roundMessage),
                    };
                }
                else if (attr instanceof Api.DocumentAttributeAudio)
                    type = "audio";
                else if (attr instanceof Api.DocumentAttributeSticker)
                    type = "sticker";
                else if (attr instanceof Api.DocumentAttributeFilename)
                    fileName = attr.fileName;
            }
            return {
                type,
                fileName,
                size: doc.size?.toJSNumber?.() ?? Number(doc.size),
                ...(video ?? {}),
            };
        }
        return undefined;
    }
    /** Resolve sender ID to a display name (Telegram MCP Starter R3).
     *
     * Три ступени, от бесплатной к дорогой:
     *   1) объект отправителя, который gramJS уже положил в само сообщение
     *      (_finishInit заполняет его из entities ТОГО ЖЕ ответа GetHistory) —
     *      сети не нужно вовсе;
     *   2) кэш имён на диске (неделя) — переживает перезапуск демона;
     *   3) getEntity() с дедупликацией залпа — только если первых двух не хватило.
     */
    async resolveSenderName(senderId, known) {
        if (!senderId || !this.client)
            return "unknown";
        const key = String(senderId);
        const fromMsg = fisNameOf(known, key);
        if (fromMsg !== null && fromMsg !== key) {
            fisCacheSet(key, fromMsg);
            fisCacheSave();
            return fromMsg;
        }
        const cached = fisCacheGet(key);
        if (cached !== null)
            return cached;
        const running = fisInflight.get(key);
        if (running)
            return running;                 // тот же id уже спрашивают — ждём общий ответ
        const task = (async () => {
            try {
                const name = fisNameOf(await this.client.getEntity(senderId), key) ?? key;
                fisCacheSet(key, name);
                fisCacheSave();
                return name;
            }
            catch {
                return key;                 // НЕ кэшируем: см. комментарий у fisCacheSet
            }
            finally {
                fisInflight.delete(key);
            }
        })();
        fisInflight.set(key, task);
        return task;
    }
    async getMessages(chatId, limit = 10, offsetId, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const opts = {
            limit,
            ...(offsetId ? { offsetId } : {}),
            ...(maxDate ? { offsetDate: maxDate } : {}),
        };
        const messages = await this.client.getMessages(resolved, opts);
        let filtered = messages;
        if (minDate) {
            filtered = filtered.filter((m) => (m.date ?? 0) >= minDate);
        }
        const results = await Promise.all(filtered.map(async (m, fisI, fisArr) => ({
            id: m.id,
            ...(await this.fisRichFieldsFull(m, resolved, fisArr)),  // Telegram MCP Starter (R4)
            sender: await this.resolveSenderName(m.senderId, m.sender),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
            // Telegram MCP Starter: полный набор параметров (см. такой же блок в getReplies).
            // replyToMsgId — жёсткая связка «ответ на вопрос»; из текстового архива
            // её задним числом не восстановить, поэтому отдаём сразу и всегда.
            senderId: m.senderId ? String(m.senderId) : null,
            replyToMsgId: m.replyTo?.replyToMsgId ?? null,
            replyToTopId: m.replyTo?.replyToTopId ?? null,
            quoteText: m.replyTo?.quoteText ?? null,
            fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
            editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
            viaBotId: m.viaBotId ? String(m.viaBotId) : null,
            groupedId: m.groupedId ? String(m.groupedId) : null,
            views: m.views ?? null,
            forwards: m.forwards ?? null,
            postAuthor: m.postAuthor ?? null,
            pinned: m.pinned ?? false,
            entities: Array.isArray(m.entities) && m.entities.length
                ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                : null,
        })));
        return results;
    }
    async searchChats(query, limit = 10) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.contacts.Search({ q: query, limit }));
        const chats = [];
        for (const user of result.users) {
            if (user instanceof Api.User) {
                const parts = [user.firstName, user.lastName].filter(Boolean);
                chats.push({
                    id: user.id.toString(),
                    name: parts.join(" ") || "Unknown",
                    type: "private",
                    username: user.username ?? undefined,
                });
            }
        }
        for (const chat of result.chats) {
            if (chat instanceof Api.Chat) {
                chats.push({
                    id: chat.id.toString(),
                    name: chat.title,
                    type: "group",
                    membersCount: chat.participantsCount ?? undefined,
                });
            }
            else if (chat instanceof Api.Channel) {
                chats.push({
                    id: chat.id.toString(),
                    name: chat.title,
                    type: chat.megagroup ? "group" : "channel",
                    username: chat.username ?? undefined,
                    membersCount: chat.participantsCount ?? undefined,
                });
            }
        }
        // Enrich channels/groups with description and accurate members count
        for (const chat of chats) {
            if (chat.type === "private")
                continue;
            try {
                const entity = await this.client.getEntity(chat.id);
                if (entity instanceof Api.Channel) {
                    const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                    if (full.fullChat instanceof Api.ChannelFull) {
                        chat.description = full.fullChat.about || undefined;
                        chat.membersCount = full.fullChat.participantsCount ?? chat.membersCount;
                    }
                }
                else if (entity instanceof Api.Chat) {
                    const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                    if (full.fullChat instanceof Api.ChatFull) {
                        chat.description = full.fullChat.about || undefined;
                    }
                }
            }
            catch {
                // Skip enrichment on error (private channels, etc.)
            }
        }
        return chats;
    }
    async searchGlobal(query, limit = 20, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.SearchGlobal({
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: minDate || 0,
            maxDate: maxDate || 0,
            offsetRate: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId: 0,
            limit,
        }));
        const chatsMap = new Map();
        if ("chats" in result) {
            for (const chat of result.chats) {
                if (chat instanceof Api.Channel) {
                    chatsMap.set(chat.id.toString(), {
                        id: chat.id.toString(),
                        name: chat.title,
                        type: chat.megagroup ? "group" : "channel",
                        username: chat.username ?? undefined,
                    });
                }
                else if (chat instanceof Api.Chat) {
                    chatsMap.set(chat.id.toString(), {
                        id: chat.id.toString(),
                        name: chat.title,
                        type: "group",
                    });
                }
            }
        }
        if ("users" in result) {
            for (const user of result.users) {
                if (user instanceof Api.User) {
                    const parts = [user.firstName, user.lastName].filter(Boolean);
                    chatsMap.set(user.id.toString(), {
                        id: user.id.toString(),
                        name: parts.join(" ") || "Unknown",
                        type: "private",
                        username: user.username ?? undefined,
                    });
                }
            }
        }
        const rawMessages = "messages" in result ? result.messages : [];
        const messages = rawMessages.filter((m) => m instanceof Api.Message);
        const results = await Promise.all(messages.map(async (m, fisI, fisArr) => {
            const peerId = m.peerId;
            let chatId = "";
            if (peerId instanceof Api.PeerChannel)
                chatId = peerId.channelId.toString();
            else if (peerId instanceof Api.PeerChat)
                chatId = peerId.chatId.toString();
            else if (peerId instanceof Api.PeerUser)
                chatId = peerId.userId.toString();
            return {
                id: m.id,
                ...(await this.fisRichFieldsFull(m, m.peerId, fisArr)),  // Telegram MCP Starter (R4)
                sender: await this.resolveSenderName(m.senderId, m.sender),
                date: new Date((m.date ?? 0) * 1000).toISOString(),
                chat: chatsMap.get(chatId) || { id: chatId, name: "Unknown", type: "unknown" },
                media: this.extractMediaInfo(m.media),
                reactions: this.extractReactions(m.reactions),
            };
        }));
        return results;
    }
    async searchMessages(chatId, query, limit = 20, minDate, maxDate) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const messages = await this.client.getMessages(resolved, {
            search: query,
            limit,
            ...(maxDate ? { offsetDate: maxDate } : {}),
        });
        let filtered = messages;
        if (minDate) {
            filtered = filtered.filter((m) => (m.date ?? 0) >= minDate);
        }
        const results = await Promise.all(filtered.map(async (m, fisI, fisArr) => ({
            id: m.id,
            ...(await this.fisRichFieldsFull(m, resolved, fisArr)),  // Telegram MCP Starter (R4)
            sender: await this.resolveSenderName(m.senderId, m.sender),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
            // Telegram MCP Starter: полный набор параметров (см. такой же блок в getReplies).
            // replyToMsgId — жёсткая связка «ответ на вопрос»; из текстового архива
            // её задним числом не восстановить, поэтому отдаём сразу и всегда.
            senderId: m.senderId ? String(m.senderId) : null,
            replyToMsgId: m.replyTo?.replyToMsgId ?? null,
            replyToTopId: m.replyTo?.replyToTopId ?? null,
            quoteText: m.replyTo?.quoteText ?? null,
            fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
            editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
            viaBotId: m.viaBotId ? String(m.viaBotId) : null,
            groupedId: m.groupedId ? String(m.groupedId) : null,
            views: m.views ?? null,
            forwards: m.forwards ?? null,
            postAuthor: m.postAuthor ?? null,
            pinned: m.pinned ?? false,
            entities: Array.isArray(m.entities) && m.entities.length
                ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                : null,
        })));
        return results;
    }
    // ─── Search ────────────────────────────────────────────────────────────────
    async getContacts(limit = 50) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
        if (!(result instanceof Api.contacts.Contacts))
            return [];
        const contacts = [];
        for (const user of result.users) {
            if (user instanceof Api.User) {
                const parts = [user.firstName, user.lastName].filter(Boolean);
                contacts.push({
                    id: user.id.toString(),
                    name: parts.join(" ") || "Unknown",
                    username: user.username ?? undefined,
                    phone: user.phone ?? undefined,
                });
            }
        }
        return contacts.slice(0, limit);
    }
    async getChatMembers(chatId, limit = 50) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.Channel) {
            const result = await this.client.invoke(new Api.channels.GetParticipants({
                channel: entity,
                filter: new Api.ChannelParticipantsRecent(),
                offset: 0,
                limit,
                hash: bigInt.zero,
            }));
            if (!(result instanceof Api.channels.ChannelParticipants))
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            return result.participants.map((p) => {
                const userId = this.getParticipantUserId(p);
                const user = userMap.get(userId);
                const parts = user ? [user.firstName, user.lastName].filter(Boolean) : [];
                return {
                    id: userId,
                    name: parts.join(" ") || "Unknown",
                    username: user?.username ?? undefined,
                    role: this.getParticipantRole(p),
                };
            });
        }
        // Basic group — use getParticipants (no role info available)
        const participants = await this.client.getParticipants(entity, { limit });
        return participants
            .filter((p) => p instanceof Api.User)
            .map((p) => {
            const parts = [p.firstName, p.lastName].filter(Boolean);
            return {
                id: p.id.toString(),
                name: parts.join(" ") || "Unknown",
                username: p.username ?? undefined,
                role: "member",
            };
        });
    }
    async getMyRole(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const me = await this.getMe();
        if (entity instanceof Api.Channel) {
            // `channels.getParticipant#a0ab6cc6 channel:InputChannel participant:InputPeer` — the
            // participant field is an InputPeer, not an InputUser. Passing InputUserSelf compiles
            // (GramJS types both as TypeEntityLike) but fails at request-serialization time with
            // "Cannot cast InputUserSelf to any kind of InputPeer", which made this tool fail 100%
            // of its production calls. InputPeerSelf is the correct self reference here.
            const result = await this.client.invoke(new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputPeerSelf() }));
            return {
                role: this.getParticipantRole(result.participant),
                chatId: entity.id.toString(),
                chatName: entity.title ?? "Unknown",
            };
        }
        if (entity instanceof Api.Chat) {
            // Basic group — check if creator
            if (entity.creator) {
                return { role: "creator", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
            }
            if (entity.adminRights) {
                return { role: "admin", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
            }
            return { role: "member", chatId: entity.id.toString(), chatName: entity.title ?? "Unknown" };
        }
        if (entity instanceof Api.User) {
            return { role: "user", chatId: entity.id.toString(), chatName: me.username ?? "self" };
        }
        return { role: "unknown", chatId: chatId, chatName: "Unknown" };
    }
    getParticipantUserId(p) {
        if (p instanceof Api.ChannelParticipantCreator)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantAdmin)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantSelf)
            return p.userId.toString();
        if (p instanceof Api.ChannelParticipantBanned)
            return p.peer?.userId?.toString() ?? "0";
        if (p instanceof Api.ChannelParticipant)
            return p.userId.toString();
        return "0";
    }
    getParticipantRole(p) {
        if (p instanceof Api.ChannelParticipantCreator)
            return "creator";
        if (p instanceof Api.ChannelParticipantAdmin)
            return "admin";
        if (p instanceof Api.ChannelParticipantBanned)
            return "banned";
        if (p instanceof Api.ChannelParticipantLeft)
            return "left";
        return "member";
    }
    async getProfile(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getEntity(userId);
        if (!(entity instanceof Api.User))
            throw new Error("Entity is not a user");
        const inputEntity = await this.client.getInputEntity(userId);
        const fullResult = await this.client.invoke(new Api.users.GetFullUser({ id: inputEntity }));
        const full = fullResult.fullUser;
        const bio = full.about ?? undefined;
        const parts = [entity.firstName, entity.lastName].filter(Boolean);
        let lastSeen;
        if (entity.status instanceof Api.UserStatusOnline) {
            lastSeen = "online";
        }
        else if (entity.status instanceof Api.UserStatusOffline) {
            lastSeen = new Date(entity.status.wasOnline * 1000).toISOString();
        }
        else if (entity.status instanceof Api.UserStatusRecently) {
            lastSeen = "recently";
        }
        else if (entity.status instanceof Api.UserStatusLastWeek) {
            lastSeen = "last week";
        }
        else if (entity.status instanceof Api.UserStatusLastMonth) {
            lastSeen = "last month";
        }
        let birthday;
        if (full.birthday) {
            const b = full.birthday;
            birthday = b.year
                ? `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`
                : `${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
        }
        let businessWorkHours;
        if (full.businessWorkHours) {
            const wh = full.businessWorkHours;
            businessWorkHours = wh.timezoneId ?? "configured";
        }
        let businessLocation;
        if (full.businessLocation) {
            const loc = full.businessLocation;
            businessLocation = loc.address ?? "configured";
        }
        return {
            id: entity.id.toString(),
            name: parts.join(" ") || "Unknown",
            username: entity.username ?? undefined,
            phone: entity.phone ?? undefined,
            bio,
            photo: !!entity.photo,
            lastSeen,
            premium: entity.premium || undefined,
            birthday,
            commonChatsCount: full.commonChatsCount || undefined,
            personalChannelId: full.personalChannelId ? full.personalChannelId.toString() : undefined,
            businessWorkHours,
            businessLocation,
        };
    }
    /**
     * List the songs pinned to a user's profile (`users.getSavedMusic`).
     *
     * The request class is hand-rolled (`./tl/saved-music.ts`) because GramJS is pinned at TL
     * layer 198, which predates this method.
     */
    async getSavedMusic(userId, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 50;
        // resolvePeer first: getInputEntity alone throws "Could not find the input entity" for
        // display-name fragments and uncached bare numeric ids. "me" is the self default.
        const resolved = await this.resolvePeer(userId ?? "me");
        // The InputPeer → InputUser conversion is mandatory. getBytes() delegates field 2 to the
        // object's own constructor id, and unlike generated requests this class has no AUTO_CASTS
        // resolve() to repair an InputPeer. getInputUser also rejects channels/groups loudly.
        const id = getInputUser(await this.client.getInputEntity(resolved));
        return this.rateLimiter.execute(async () => {
            const request = new GetSavedMusicRequest(id, offset, limit);
            // invoke() is typed over a closed union of generated classes, which a hand-rolled
            // request cannot join; the outbound cast collapses the return type, so restore it.
            const response = (await this.client?.invoke(request));
            if (!response)
                throw new Error("users.getSavedMusic returned nothing");
            return summarizeSavedMusic(response, offset);
        }, `getSavedMusic ${userId ?? "me"}`);
    }
    // ─── Profiles & Media ──────────────────────────────────────────────────────
    async downloadProfilePhoto(entityId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getEntity(entityId);
        const buffer = (await this.client.downloadProfilePhoto(entity, {
            isBig: options?.isBig !== false,
        }));
        if (!buffer || buffer.length === 0)
            return null;
        const mimeType = this.detectMimeFromBuffer(buffer);
        if (options?.savePath) {
            await writeFile(options.savePath, buffer);
            return { filePath: options.savePath };
        }
        return { buffer, mimeType };
    }
    /** Detect MIME type from buffer magic bytes */
    detectMimeFromBuffer(buffer) {
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
            return "image/jpeg";
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
            return "image/png";
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
            return "image/gif";
        if (buffer[0] === 0x52 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x46 &&
            buffer[8] === 0x57 &&
            buffer[9] === 0x45 &&
            buffer[10] === 0x42 &&
            buffer[11] === 0x50)
            return "image/webp";
        return "image/jpeg"; // Telegram profile photos are almost always JPEG
    }
    /** Extract reactions from a message into a simple format */
    extractReactions(reactions) {
        if (!reactions?.results?.length)
            return undefined;
        const items = [];
        for (const r of reactions.results) {
            let emoji;
            if (r.reaction instanceof Api.ReactionEmoji) {
                emoji = r.reaction.emoticon;
            }
            else if (r.reaction instanceof Api.ReactionCustomEmoji) {
                emoji = `custom:${r.reaction.documentId}`;
            }
            else if (r.reaction instanceof Api.ReactionPaid) {
                emoji = "⭐";
            }
            else {
                continue;
            }
            items.push({ emoji, count: r.count, me: r.chosenOrder != null });
        }
        return items.length > 0 ? items : undefined;
    }
    // ─── Reactions ─────────────────────────────────────────────────────────────
    async sendReaction(chatId, messageId, emoji, addToExisting = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const reactionList = [];
        if (emoji) {
            const emojis = Array.isArray(emoji) ? emoji : [emoji];
            if (addToExisting) {
                // Fetch current reactions to preserve them
                const msgs = await this.client.getMessages(resolved, { ids: [messageId] });
                const msg = msgs[0];
                if (msg?.reactions?.results) {
                    for (const r of msg.reactions.results) {
                        if (r.chosenOrder != null) {
                            reactionList.push(r.reaction);
                        }
                    }
                }
            }
            for (const e of emojis) {
                reactionList.push(new Api.ReactionEmoji({ emoticon: e }));
            }
        }
        // empty array = remove all reactions
        const result = await this.client.invoke(new Api.messages.SendReaction({
            peer,
            msgId: messageId,
            reaction: reactionList,
        }));
        // Extract updated reactions from the response
        if ("updates" in result) {
            for (const upd of result.updates) {
                if (upd instanceof Api.UpdateMessageReactions) {
                    return this.extractReactions(upd.reactions);
                }
            }
        }
        return undefined;
    }
    async getMessageReactions(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        // First get the message to know which reactions exist
        const msgs = await this.client.getMessages(resolved, { ids: [messageId] });
        const msg = msgs[0];
        if (!msg?.reactions?.results?.length) {
            return { reactions: [], total: 0 };
        }
        const reactionsOut = [];
        for (const rc of msg.reactions.results) {
            let emoji;
            if (rc.reaction instanceof Api.ReactionEmoji) {
                emoji = rc.reaction.emoticon;
            }
            else if (rc.reaction instanceof Api.ReactionCustomEmoji) {
                emoji = `custom:${rc.reaction.documentId}`;
            }
            else if (rc.reaction instanceof Api.ReactionPaid) {
                emoji = "⭐";
            }
            else {
                continue;
            }
            const users = [];
            // Try to get the list of users who reacted (may fail if canSeeList is false)
            if (msg.reactions.canSeeList) {
                try {
                    const list = await this.client.invoke(new Api.messages.GetMessageReactionsList({
                        peer,
                        id: messageId,
                        reaction: rc.reaction,
                        limit: 50,
                    }));
                    if (list instanceof Api.messages.MessageReactionsList) {
                        for (const r of list.reactions) {
                            const userId = r.peerId instanceof Api.PeerUser ? r.peerId.userId.toString() : "";
                            if (userId) {
                                const name = await this.resolveSenderName(bigInt(userId));
                                users.push({ id: userId, name });
                            }
                        }
                    }
                }
                catch {
                    // canSeeList may be false or request may fail for channels
                }
            }
            reactionsOut.push({ emoji, count: rc.count, users });
        }
        const total = reactionsOut.reduce((sum, r) => sum + r.count, 0);
        return { reactions: reactionsOut, total };
    }
    async setDefaultReaction(emoji) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.messages.SetDefaultReaction({
                reaction: new Api.ReactionEmoji({ emoticon: emoji }),
            }));
        }, `setDefaultReaction ${emoji}`);
    }
    async getTopReactions(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetTopReactions({ limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.ReactionsNotModified)
                return [];
            const out = [];
            for (const r of result.reactions) {
                const emoji = reactionToEmoji(r);
                if (emoji)
                    out.push({ emoji });
            }
            return out;
        }, "getTopReactions");
    }
    async getRecentReactions(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetRecentReactions({ limit, hash: bigInt(0) }));
            if (!result || result instanceof Api.messages.ReactionsNotModified)
                return [];
            const out = [];
            for (const r of result.reactions) {
                const emoji = reactionToEmoji(r);
                if (emoji)
                    out.push({ emoji });
            }
            return out;
        }, "getRecentReactions");
    }
    // ─── Scheduled & Polls ─────────────────────────────────────────────────────
    async sendScheduledMessage(chatId, text, scheduleDate, replyTo, parseMode) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        await this.client.sendMessage(resolved, {
            message: text,
            schedule: scheduleDate,
            ...(replyTo ? { replyTo } : {}),
            ...(parseMode ? { parseMode: parseMode === "html" ? "html" : "md" } : {}),
        });
    }
    async createPoll(chatId, question, answers, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.client.getInputEntity(chatId);
        const pollAnswers = answers.map((text, i) => new Api.PollAnswer({
            text: new Api.TextWithEntities({ text, entities: [] }),
            option: Buffer.from([i]),
        }));
        const poll = new Api.Poll({
            id: bigInt(Date.now()),
            question: new Api.TextWithEntities({ text: question, entities: [] }),
            answers: pollAnswers,
            multipleChoice: options?.multipleChoice ?? false,
            quiz: options?.quiz ?? false,
        });
        const result = await this.client.invoke(new Api.messages.SendMedia({
            peer,
            media: new Api.InputMediaPoll({
                poll,
                ...(options?.quiz && options.correctAnswer != null
                    ? { correctAnswers: [Buffer.from([options.correctAnswer])] }
                    : {}),
            }),
            message: "",
            randomId: bigInt(Math.floor(Math.random() * 1e15)),
        }));
        // Extract message ID from result
        if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
            for (const update of result.updates) {
                if (update instanceof Api.UpdateMessageID) {
                    return update.id;
                }
            }
        }
        return 0;
    }
    // ─── Poll interaction ──────────────────────────────────────────────────────
    async sendPollVote(chatId, messageId, optionIndexes) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const options = optionIndexes.map((i) => Buffer.from([i]));
            const result = await client.invoke(new Api.messages.SendVote({ peer, msgId: messageId, options }));
            const pollMedia = extractPollMediaFromUpdates(result);
            const results = pollMedia?.results;
            const poll = pollMedia?.poll;
            return {
                totalVoters: results?.totalVoters ?? 0,
                chosenLabels: optionIndexes.map((i) => {
                    const answer = poll?.answers?.[i];
                    return answer ? answer.text.text : `#${i}`;
                }),
                isRetracted: optionIndexes.length === 0,
            };
        }, `sendPollVote ${chatId}/${messageId}`);
    }
    async getPollResults(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const msgs = await client.getMessages(peer, { ids: [messageId] });
            if (!(msgs[0]?.media instanceof Api.MessageMediaPoll)) {
                throw new Error("Message is not a poll");
            }
            const pollMedia = msgs[0].media;
            // Refresh results from server
            try {
                await client.invoke(new Api.messages.GetPollResults({ peer, msgId: messageId }));
            }
            catch {
                // ignore — use whatever is in the message
            }
            return summarizePoll(pollMedia.poll, pollMedia.results);
        }, `getPollResults ${chatId}/${messageId}`);
    }
    async getPollVoters(chatId, messageId, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const optionIndex = opts?.optionIndex;
            const result = (await client.invoke(new Api.messages.GetPollVotes({
                peer,
                id: messageId,
                option: optionIndex !== undefined ? Buffer.from([optionIndex]) : undefined,
                offset: opts?.offset,
                limit: opts?.limit ?? 20,
            })));
            // Build user map
            const userMap = new Map();
            for (const u of result.users ?? []) {
                const user = u;
                const id = user.id?.toString() ?? "";
                userMap.set(id, {
                    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
                    username: user.username ?? undefined,
                });
            }
            const voters = (result.votes ?? []).map((v) => {
                const vote = v;
                const peerId = extractPeerId(vote.peer);
                const info = userMap.get(peerId) ?? {};
                let options = [];
                if ("option" in vote && vote.option) {
                    options = [Buffer.from(vote.option).toString("hex")];
                }
                else if ("options" in vote && vote.options) {
                    options = vote.options.map((o) => Buffer.from(o).toString("hex"));
                }
                return {
                    peerId,
                    name: info.name,
                    username: info.username,
                    options,
                    date: vote.date,
                };
            });
            return { total: result.count, nextOffset: result.nextOffset, voters };
        }, `getPollVoters ${chatId}/${messageId}`);
    }
    async closePoll(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            // Step 1: fetch existing poll
            const msgs = await client.getMessages(peer, { ids: [messageId] });
            if (!(msgs[0]?.media instanceof Api.MessageMediaPoll)) {
                throw new Error("Message is not a poll");
            }
            const pollMedia = msgs[0].media;
            const originalPoll = pollMedia.poll;
            // Step 2: build closed poll (preserve all flags)
            const closedPoll = new Api.Poll({
                id: originalPoll.id,
                question: originalPoll.question,
                answers: originalPoll.answers,
                closed: true,
                publicVoters: originalPoll.publicVoters,
                multipleChoice: originalPoll.multipleChoice,
                quiz: originalPoll.quiz,
                closePeriod: originalPoll.closePeriod,
                closeDate: originalPoll.closeDate,
            });
            // Step 3: edit message to close poll
            const result = await client.invoke(new Api.messages.EditMessage({
                peer,
                id: messageId,
                media: new Api.InputMediaPoll({ poll: closedPoll }),
            }));
            // Extract updated voter count from result updates
            const pollInfo = extractPollMediaFromUpdates(result);
            const totalVoters = pollInfo?.results?.totalVoters ?? pollMedia.results?.totalVoters ?? 0;
            return { totalVoters };
        }, `closePoll ${chatId}/${messageId}`);
    }
    // ─── Audio transcription ───────────────────────────────────────────────────
    async transcribeAudio(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = (await client.invoke(new Api.messages.TranscribeAudio({ peer, msgId: messageId })));
            return {
                transcriptionId: result.transcriptionId.toString(),
                text: result.text ?? "",
                pending: result.pending ?? false,
                trialRemainsNum: result.trialRemainsNum,
                trialRemainsUntilDate: result.trialRemainsUntilDate,
            };
        }, `transcribeAudio ${chatId}/${messageId}`);
    }
    async rateTranscription(chatId, messageId, transcriptionId, good) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.RateTranscribedAudio({
                peer,
                msgId: messageId,
                transcriptionId: bigInt(transcriptionId),
                good,
            }));
        }, `rateTranscription ${chatId}/${messageId}`);
    }
    // ─── Fact-check ────────────────────────────────────────────────────────────
    async getFactCheck(chatId, messageIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = (await client.invoke(new Api.messages.GetFactCheck({ peer, msgId: messageIds })));
            return result.map((fc, i) => ({
                messageId: messageIds[i],
                needCheck: fc.needCheck ?? false,
                country: fc.country,
                text: fc.text?.text,
                hash: fc.hash.toString(),
            }));
        }, `getFactCheck ${chatId}`);
    }
    async editFactCheck(chatId, messageId, text, _opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            // Build TextWithEntities — basic plain text (no entity parsing for fact-checks)
            const textObj = new Api.TextWithEntities({ text, entities: [] });
            await client.invoke(new Api.messages.EditFactCheck({ peer, msgId: messageId, text: textObj }));
        }, `editFactCheck ${chatId}/${messageId}`);
    }
    async deleteFactCheck(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.DeleteFactCheck({ peer, msgId: messageId }));
        }, `deleteFactCheck ${chatId}/${messageId}`);
    }
    // ─── Paid reactions ────────────────────────────────────────────────────────
    async sendPaidReaction(chatId, messageId, count, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const randomId = generateRandomBigInt();
            const params = { peer, msgId: messageId, count, randomId };
            if (opts?.private !== undefined)
                params.private = opts.private;
            // biome-ignore lint/suspicious/noExplicitAny: dynamic params for optional `private` field
            await client.invoke(new Api.messages.SendPaidReaction(params));
            return { count };
        }, `sendPaidReaction ${chatId}/${messageId}`);
    }
    async togglePaidReactionPrivacy(chatId, messageId, privateFlag) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const client = this.client;
        await this.rateLimiter.execute(async () => {
            await client.invoke(new Api.messages.TogglePaidReactionPrivacy({ peer, msgId: messageId, private: privateFlag }));
        }, `togglePaidReactionPrivacy ${chatId}/${messageId}`);
    }
    async getPaidReactionPrivacy() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = await client.invoke(new Api.messages.GetPaidReactionPrivacy());
            let list = [];
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                list = result.updates;
            }
            else if (result instanceof Api.UpdateShort) {
                list = [result.update];
            }
            for (const u of list) {
                if (u instanceof Api.UpdatePaidReactionPrivacy) {
                    return { private: Boolean(u.private) };
                }
            }
            return { private: false };
        }, "getPaidReactionPrivacy");
    }
    async getForumTopics(chatId, limit = 100) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Forum topics are only available in supergroups");
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        // Telegram MCP Starter (M19): the pinned teleproto schema uses messages.GetForumTopics(peer).
        const result = await this.client.invoke(new Api.messages.GetForumTopics({
            peer,
            limit,
            offsetTopic: 0,
            offsetDate: 0,
            offsetId: 0,
        }));
        const topics = [];
        for (const topic of result.topics) {
            if (topic instanceof Api.ForumTopic) {
                topics.push({
                    id: topic.id,
                    title: topic.title,
                    unreadCount: topic.unreadCount,
                    unreadMentions: topic.unreadMentionsCount,
                    iconColor: topic.iconColor,
                    // Telegram MCP Starter (M14): иконку темы апстрим не отдавал вовсе, и
                    // сверить оформление двух групп было нечем — глазами по скриншоту.
                    // iconEmojiId — long, наружу только строкой: JSON его не переживёт.
                    iconEmojiId: topic.iconEmojiId ? topic.iconEmojiId.toString() : undefined,
                    closed: Boolean(topic.closed),
                    hidden: Boolean(topic.hidden),
                    pinned: Boolean(topic.pinned),
                });
            }
        }
        return topics;
    }
    async getTopicMessages(chatId, topicId, limit = 20, offsetId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const result = await this.client.invoke(new Api.messages.GetReplies({
            peer,
            msgId: topicId,
            limit,
            ...(offsetId ? { offsetId } : {}),
            offsetDate: 0,
            addOffset: 0,
            maxId: 0,
            minId: 0,
            hash: bigInt(0),
        }));
        const messages = "messages" in result ? result.messages : [];
        const results = await Promise.all(messages
            .filter((m) => m instanceof Api.Message)
            .map(async (m, fisI, fisArr) => ({
            id: m.id,
            ...(await this.fisRichFieldsFull(m, peer, fisArr)),  // Telegram MCP Starter (R4)
            sender: await this.resolveSenderName(m.senderId, m.sender),
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            media: this.extractMediaInfo(m.media),
            reactions: this.extractReactions(m.reactions),
            // Telegram MCP Starter: полный набор параметров (см. такой же блок в getReplies).
            // replyToMsgId — жёсткая связка «ответ на вопрос»; из текстового архива
            // её задним числом не восстановить, поэтому отдаём сразу и всегда.
            senderId: m.senderId ? String(m.senderId) : null,
            replyToMsgId: m.replyTo?.replyToMsgId ?? null,
            replyToTopId: m.replyTo?.replyToTopId ?? null,
            quoteText: m.replyTo?.quoteText ?? null,
            fwdFrom: m.fwdFrom ? { date: m.fwdFrom.date ?? null, fromName: m.fwdFrom.fromName ?? null,
                fromId: m.fwdFrom.fromId ? String(m.fwdFrom.fromId) : null, channelPost: m.fwdFrom.channelPost ?? null } : null,
            editDate: m.editDate ? new Date(m.editDate * 1000).toISOString() : null,
            viaBotId: m.viaBotId ? String(m.viaBotId) : null,
            groupedId: m.groupedId ? String(m.groupedId) : null,
            views: m.views ?? null,
            forwards: m.forwards ?? null,
            postAuthor: m.postAuthor ?? null,
            pinned: m.pinned ?? false,
            entities: Array.isArray(m.entities) && m.entities.length
                ? m.entities.map((e) => ({ type: e.className, offset: e.offset, length: e.length, url: e.url ?? null, documentId: e.documentId ? e.documentId.toString() : null })) // Telegram MCP Starter: documentId кастомных эмодзи
                : null,
        })));
        return results;
    }
    /** Check if a chat entity is a forum (has topics enabled) */
    async isForum(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        try {
            const entity = await this.resolveChat(chatId);
            if (entity instanceof Api.Channel) {
                return Boolean(entity.forum);
            }
        }
        catch {
            // Probe semantics: an unresolvable chat simply is not a forum, so report false
            // instead of turning a lookup miss into a tool error.
        }
        return false;
    }
    // ─── Chat membership & management ──────────────────────────────────────────
    async joinChat(target) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        // Extract invite hash from various link formats
        const inviteMatch = target.match(/(?:t\.me\/\+|t\.me\/joinchat\/|tg:\/\/join\?invite=)([a-zA-Z0-9_-]+)/);
        if (inviteMatch) {
            const result = await this.client.invoke(new Api.messages.ImportChatInvite({ hash: inviteMatch[1] }));
            const chat = result.chats?.[0];
            if (!chat)
                throw new Error("Failed to join via invite link");
            return {
                id: chat.id.toString(),
                title: chat.title ?? "Unknown",
                type: chat.className === "Channel" ? "channel" : "group",
            };
        }
        // Public channel/group by username
        const username = target.replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
        const entity = await this.client.getEntity(username);
        if (entity instanceof Api.Chat) {
            throw new Error("Basic groups cannot be joined by username; use an invite link instead.");
        }
        if (entity instanceof Api.Channel) {
            await this.client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            return {
                id: entity.id.toString(),
                title: entity.title ?? "Unknown",
                type: entity.className === "Channel" ? "channel" : "group",
            };
        }
        throw new Error("Target is not a group or channel. Use username, @username, or invite link.");
    }
    async createGroup(options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const { title, users, supergroup = false, forum = false, description } = options;
        if (supergroup || forum) {
            // Create supergroup/channel via channels.CreateChannel
            const result = await this.client.invoke(new Api.channels.CreateChannel({
                title,
                about: description ?? "",
                megagroup: true,
                forum: forum || undefined,
            }));
            const chat = result.chats?.[0];
            if (!chat)
                throw new Error("Failed to create supergroup");
            const channelId = chat.id.toString();
            // Invite users
            let missingInvitees = [];
            if (users.length > 0) {
                const inputUsers = [];
                for (const u of users) {
                    try {
                        const entity = await this.client.getEntity(u);
                        if (entity instanceof Api.User) {
                            inputUsers.push(new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }));
                        }
                    }
                    catch {
                        // Skip unresolvable users
                    }
                }
                if (inputUsers.length > 0) {
                    const invited = await this.client.invoke(new Api.channels.InviteToChannel({
                        channel: chat,
                        users: inputUsers,
                    }));
                    missingInvitees = missingInviteeIds(invited);
                }
            }
            // Get invite link
            let inviteLink;
            try {
                const exported = await this.client.invoke(new Api.messages.ExportChatInvite({ peer: chat }));
                if (exported instanceof Api.ChatInviteExported) {
                    inviteLink = exported.link;
                }
            }
            catch {
                // The invite link is optional enrichment (needs admin rights); the chat data
                // returned below is still valid without it.
            }
            return {
                id: channelId,
                title,
                type: forum ? "forum" : "supergroup",
                inviteLink,
                ...(missingInvitees.length > 0 && { missingInvitees }),
            };
        }
        // Create basic group via messages.CreateChat
        const inputUsers = [];
        for (const u of users) {
            try {
                const entity = await this.client.getEntity(u);
                if (entity instanceof Api.User) {
                    inputUsers.push(new Api.InputUser({ userId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }));
                }
            }
            catch {
                // Skip unresolvable users
            }
        }
        if (inputUsers.length === 0) {
            throw new Error("At least one valid user is required to create a basic group");
        }
        const result = await this.client.invoke(new Api.messages.CreateChat({
            title,
            users: inputUsers,
        }));
        // messages.CreateChat returns `messages.InvitedUsers` ({ updates, missingInvitees }),
        // not `Updates` directly — reading `.chats` off the raw result always yielded
        // undefined and threw "Failed to create group" for a group Telegram had already
        // created. See unwrapInvitedUsers().
        const updates = unwrapInvitedUsers(result);
        const chat = updates.chats?.[0];
        if (!chat)
            throw new Error("Failed to create group");
        const missingInvitees = missingInviteeIds(result);
        return {
            id: chat.id.toString(),
            title,
            type: "group",
            ...(missingInvitees.length > 0 && { missingInvitees }),
        };
    }
    async inviteToGroup(chatId, users) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const invited = [];
        const failed = [];
        for (const u of users) {
            try {
                const user = await this.client.getEntity(u);
                if (!(user instanceof Api.User)) {
                    failed.push(u);
                    continue;
                }
                const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
                let res;
                if (entity instanceof Api.Channel) {
                    res = await this.client.invoke(new Api.channels.InviteToChannel({ channel: entity, users: [inputUser] }));
                }
                else if (entity instanceof Api.Chat) {
                    res = await this.client.invoke(new Api.messages.AddChatUser({ chatId: entity.id, userId: inputUser, fwdLimit: 50 }));
                }
                // Telegram answers 200 while silently declining users whose privacy settings
                // forbid the invite; they come back in `missingInvitees`. Reporting those as
                // invited made the tool claim work it had not done.
                if (missingInviteeIds(res).length > 0)
                    failed.push(u);
                else
                    invited.push(u);
            }
            catch {
                failed.push(u);
            }
        }
        return { invited, failed };
    }
    async kickUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        if (entity instanceof Api.Channel) {
            // Kick = ban + unban (removes without permanent ban)
            await this.client.invoke(new Api.channels.EditBanned({
                channel: entity,
                participant: inputUser,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
            }));
            await this.client.invoke(new Api.channels.EditBanned({
                channel: entity,
                participant: inputUser,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
            }));
        }
        else if (entity instanceof Api.Chat) {
            await this.client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: inputUser }));
        }
    }
    async banUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        if (!(entity instanceof Api.Channel))
            throw new Error("Ban is only supported for supergroups and channels");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditBanned({
            channel: entity,
            participant: inputUser,
            bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
        }));
    }
    async unbanUser(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        if (!(entity instanceof Api.Channel))
            throw new Error("Unban is only supported for supergroups and channels");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditBanned({
            channel: entity,
            participant: inputUser,
            bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
        }));
    }
    async editGroup(chatId, options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (options.title) {
            if (entity instanceof Api.Channel) {
                await this.client.invoke(new Api.channels.EditTitle({ channel: entity, title: options.title }));
            }
            else if (entity instanceof Api.Chat) {
                await this.client.invoke(new Api.messages.EditChatTitle({ chatId: entity.id, title: options.title }));
            }
        }
        if (options.description != null) {
            await this.client.invoke(new Api.messages.EditChatAbout({ peer: entity, about: options.description }));
        }
        if (options.photoPath) {
            const fileData = await readFile(options.photoPath);
            const uploaded = await this.client.uploadFile({
                file: new CustomFile(options.photoPath, fileData.length, options.photoPath, fileData),
                workers: 1,
            });
            const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded });
            if (entity instanceof Api.Channel) {
                await this.client.invoke(new Api.channels.EditPhoto({ channel: entity, photo: inputPhoto }));
            }
            else if (entity instanceof Api.Chat) {
                await this.client.invoke(new Api.messages.EditChatPhoto({ chatId: entity.id, photo: inputPhoto }));
            }
        }
    }
    async leaveGroup(chatId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (entity instanceof Api.Channel) {
            await this.client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
        }
        else if (entity instanceof Api.Chat) {
            await this.client.invoke(new Api.messages.DeleteChatUser({
                chatId: entity.id,
                userId: new Api.InputUserSelf(),
            }));
        }
        else {
            throw new Error("Target is not a group or channel");
        }
    }
    async setAdmin(chatId, userId, options) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Set admin is only supported for supergroups and channels");
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditAdmin({
            channel: entity,
            userId: inputUser,
            adminRights: new Api.ChatAdminRights({
                changeInfo: true,
                postMessages: true,
                editMessages: true,
                deleteMessages: true,
                banUsers: true,
                inviteUsers: true,
                pinMessages: true,
                manageCall: true,
            }),
            rank: options?.title ?? "",
        }));
    }
    async removeAdmin(chatId, userId) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.resolveChat(chatId);
        if (!(entity instanceof Api.Channel))
            throw new Error("Remove admin is only supported for supergroups and channels");
        const user = await this.client.getEntity(userId);
        if (!(user instanceof Api.User))
            throw new Error("Target is not a user");
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
        await this.client.invoke(new Api.channels.EditAdmin({
            channel: entity,
            userId: inputUser,
            adminRights: new Api.ChatAdminRights({}),
            rank: "",
        }));
    }
    // ─── Chat settings & moderation ────────────────────────────────────────────
    async unblockUser(userId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const entity = await this.client.getInputEntity(userId);
        await this.client.invoke(new Api.contacts.Unblock({ id: entity }));
    }
    async muteChat(chatId, muteUntil) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer }),
            settings: new Api.InputPeerNotifySettings({ muteUntil }),
        }));
    }
    async archiveChat(chatId, archive) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.folders.EditPeerFolders({
                folderPeers: [new Api.InputFolderPeer({ peer, folderId: archive ? 1 : 0 })],
            }));
        }, `archiveChat ${chatId}`);
    }
    async pinDialog(chatId, pin) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.ToggleDialogPin({
                peer: new Api.InputDialogPeer({ peer }),
                pinned: pin,
            }));
        }, `pinDialog ${chatId}`);
    }
    async markDialogUnread(chatId, unread) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.MarkDialogUnread({
                peer: new Api.InputDialogPeer({ peer }),
                unread,
            }));
        }, `markDialogUnread ${chatId}`);
    }
    async getAdminLog(chatId, limit = 20, q) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Admin log is only available for supergroups and channels");
            }
            const result = await this.client?.invoke(new Api.channels.GetAdminLog({
                channel: entity,
                q: q ?? "",
                maxId: bigInt(0),
                minId: bigInt(0),
                limit,
            }));
            if (!result)
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const describeUser = (userId) => {
                const user = userMap.get(userId.toString());
                if (!user)
                    return userId.toString();
                const parts = [user.firstName, user.lastName].filter(Boolean);
                const name = parts.join(" ") || "Unknown";
                return user.username ? `${name} (@${user.username})` : name;
            };
            return result.events.map((event) => ({
                id: event.id.toString(),
                date: new Date((event.date ?? 0) * 1000).toISOString(),
                userId: event.userId.toString(),
                userName: describeUser(event.userId),
                action: describeAdminLogAction(event.action),
                details: describeAdminLogDetails(event.action, describeUser),
            }));
        }, `getAdminLog for ${chatId}`);
    }
    async setChatPermissions(chatId, permissions) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        if (Object.values(permissions).every((v) => v === undefined))
            return;
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            let currentRights;
            if (entity instanceof Api.Channel) {
                const full = await this.client?.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                const fullChannel = full?.chats?.find((c) => c instanceof Api.Channel && c.id.equals(entity.id));
                currentRights = fullChannel?.defaultBannedRights ?? undefined;
            }
            else if (entity instanceof Api.Chat) {
                const full = await this.client?.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
                const fullChat = full?.chats?.find((c) => c instanceof Api.Chat && c.id.equals(entity.id));
                currentRights = fullChat?.defaultBannedRights ?? undefined;
            }
            const peer = await this.client?.getInputEntity(entity);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            await this.client?.invoke(new Api.messages.EditChatDefaultBannedRights({
                peer,
                bannedRights: new Api.ChatBannedRights({ untilDate: 0, ...mergeBannedRights(currentRights, permissions) }),
            }));
        }, `setChatPermissions ${chatId}`);
    }
    async setSlowMode(chatId, seconds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const allowed = [0, 10, 30, 60, 300, 900, 3600];
        if (!allowed.includes(seconds)) {
            throw new Error(`Invalid slow mode interval. Allowed values: ${allowed.join(", ")} (seconds)`);
        }
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Slow mode is only available for supergroups");
            }
            await this.client?.invoke(new Api.channels.ToggleSlowMode({ channel: entity, seconds }));
        }, `setSlowMode ${chatId}`);
    }
    async toggleChannelSignatures(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Channel signatures are only available for broadcast channels (not groups or supergroups)");
            }
            if (entity.megagroup) {
                throw new Error("Channel signatures are only available for broadcast channels, not supergroups");
            }
            await this.client?.invoke(new Api.channels.ToggleSignatures({ channel: entity, signaturesEnabled: enabled }));
        }, `toggleChannelSignatures ${chatId}`);
    }
    async toggleAntiSpam(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Aggressive anti-spam is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Aggressive anti-spam is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.ToggleAntiSpam({ channel: entity, enabled }));
        }, `toggleAntiSpam ${chatId}`);
    }
    async toggleForumMode(chatId, enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Forum mode is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Forum mode is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.ToggleForum({ channel: entity, enabled }));
        }, `toggleForumMode ${chatId}`);
    }
    async togglePrehistoryHidden(chatId, hidden) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Prehistory visibility is only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Prehistory visibility is only available for supergroups, not broadcast channels");
            }
            await this.client?.invoke(new Api.channels.TogglePreHistoryHidden({ channel: entity, enabled: hidden }));
        }, `togglePrehistoryHidden ${chatId}`);
    }
    async setChatAvailableReactions(chatId, reactions) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) && !(entity instanceof Api.Chat)) {
                throw new Error("Chat reactions can only be configured for groups, supergroups, and channels");
            }
            let availableReactions;
            if (reactions.type === "all") {
                availableReactions = new Api.ChatReactionsAll({ allowCustom: reactions.allowCustom });
            }
            else if (reactions.type === "none") {
                availableReactions = new Api.ChatReactionsNone();
            }
            else {
                if (reactions.emoji.length === 0) {
                    throw new Error('reactions.emoji must be non-empty when type is "some" (use type:"none" to disable)');
                }
                availableReactions = new Api.ChatReactionsSome({
                    reactions: reactions.emoji.map((emoticon) => new Api.ReactionEmoji({ emoticon })),
                });
            }
            await this.client?.invoke(new Api.messages.SetChatAvailableReactions({ peer: entity, availableReactions }));
        }, `setChatAvailableReactions ${chatId}`);
    }
    async approveChatJoinRequest(chatId, userId, approved) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Join request approval is only supported for supergroups and channels, not basic groups");
            }
            const user = await this.client?.getEntity(userId);
            if (!(user instanceof Api.User)) {
                throw new Error("Target is not a user");
            }
            const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? bigInt.zero });
            await this.client?.invoke(new Api.messages.HideChatJoinRequest({ peer: entity, userId: inputUser, approved }));
        }, `approveChatJoinRequest ${chatId}/${userId}`);
    }
    // ─── Inline bots & buttons ─────────────────────────────────────────────────
    async getInlineBotResults(bot, chatId, query, offset) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const peer = await this.resolveChat(chatId);
            const botEntity = await this.client?.getEntity(bot);
            if (!(botEntity instanceof Api.User)) {
                throw new Error(`'${bot}' is not a user/bot`);
            }
            if (!botEntity.bot) {
                throw new Error(`'${bot}' is not a bot (inline queries require a bot account)`);
            }
            const inputBot = new Api.InputUser({
                userId: botEntity.id,
                accessHash: botEntity.accessHash ?? bigInt.zero,
            });
            const result = await this.client?.invoke(new Api.messages.GetInlineBotResults({
                bot: inputBot,
                peer,
                query,
                offset: offset ?? "",
            }));
            if (!result)
                throw new Error("No inline bot results returned");
            return {
                queryId: result.queryId.toString(),
                nextOffset: result.nextOffset,
                cacheTime: result.cacheTime,
                gallery: result.gallery === true,
                results: result.results.map((r) => {
                    if (r instanceof Api.BotInlineResult) {
                        return { id: r.id, type: r.type, title: r.title, description: r.description, url: r.url };
                    }
                    const mr = r;
                    return { id: mr.id, type: mr.type, title: mr.title, description: mr.description };
                }),
            };
        }, `getInlineBotResults via ${bot}`);
    }
    async sendInlineBotResult(chatId, queryId, resultId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const peer = await this.resolveChat(chatId);
            const randomId = bigInt(Math.floor(Math.random() * 1e15));
            const replyTo = options?.replyTo ? new Api.InputReplyToMessage({ replyToMsgId: options.replyTo }) : undefined;
            const result = await this.client?.invoke(new Api.messages.SendInlineBotResult({
                peer,
                queryId: bigInt(queryId),
                id: resultId,
                randomId,
                ...(replyTo ? { replyTo } : {}),
                ...(options?.silent ? { silent: true } : {}),
                ...(options?.hideVia ? { hideVia: true } : {}),
                ...(options?.clearDraft ? { clearDraft: true } : {}),
            }));
            if (!result)
                throw new Error("No response from SendInlineBotResult");
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId)) {
                        return { messageId: update.id };
                    }
                }
            }
            if (result instanceof Api.UpdateShortSentMessage) {
                return { messageId: result.id };
            }
            return { messageId: 0 };
        }, `sendInlineBotResult ${resultId} to ${chatId}`);
    }
    async pressButton(chatId, messageId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            let data;
            if (options.buttonIndex) {
                const { row, column } = options.buttonIndex;
                const messages = await this.client?.getMessages(entity, { ids: [messageId] });
                const msg = messages?.[0];
                if (!msg)
                    throw new Error(`Message ${messageId} not found in ${chatId}`);
                const markup = msg.replyMarkup;
                if (!markup)
                    throw new Error(`Message ${messageId} has no reply markup`);
                if (!(markup instanceof Api.ReplyInlineMarkup)) {
                    throw new Error(`Message ${messageId} reply markup is ${markup.className} (only ReplyInlineMarkup has callable buttons)`);
                }
                const rowEntry = markup.rows[row];
                if (!rowEntry)
                    throw new Error(`Row ${row} out of bounds (message has ${markup.rows.length} rows)`);
                const button = rowEntry.buttons[column];
                if (!button) {
                    throw new Error(`Column ${column} out of bounds in row ${row} (row has ${rowEntry.buttons.length} buttons)`);
                }
                // Telegram MCP Starter (M5): у кнопки мини-приложения общий отказ «not callable»
                // ничего не подсказывал. Называем инструмент, которым её открывают.
                if (button instanceof Api.KeyboardButtonWebView || button instanceof Api.KeyboardButtonSimpleWebView) {
                    throw new Error(`Кнопка (${row},${column}) открывает мини-приложение. Используйте telegram-open-mini-app с bot: "${chatId}".`);
                }
                if (!(button instanceof Api.KeyboardButtonCallback)) {
                    throw new Error(`Button at (${row},${column}) is ${button.className}, not callable — use the appropriate tool for URL/switch-inline/game buttons`);
                }
                if (button.requiresPassword) {
                    throw new Error(`Button at (${row},${column}) requires 2FA password confirmation — not supported by telegram-press-button`);
                }
                data = Buffer.from(button.data);
            }
            else if (options.data !== undefined) {
                data = Buffer.from(options.data, "base64");
            }
            else {
                throw new Error("Either buttonIndex or data must be provided");
            }
            const answer = await this.client?.invoke(new Api.messages.GetBotCallbackAnswer({
                peer: entity,
                msgId: messageId,
                data,
            }));
            if (!answer)
                throw new Error("No callback answer returned");
            return {
                alert: answer.alert,
                hasUrl: answer.hasUrl,
                nativeUi: answer.nativeUi,
                message: answer.message,
                url: answer.url,
                cacheTime: answer.cacheTime,
            };
        }, `pressButton ${chatId}/${messageId}`);
    }
    async getMessageButtons(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            const messages = await this.client?.getMessages(entity, { ids: [messageId] });
            const msg = messages?.[0];
            if (!msg)
                throw new Error(`Message ${messageId} not found in ${chatId}`);
            const markup = msg.replyMarkup;
            if (!markup) {
                return { markupType: "none", buttons: [] };
            }
            if (!(markup instanceof Api.ReplyInlineMarkup) && !(markup instanceof Api.ReplyKeyboardMarkup)) {
                return { markupType: markup.className, buttons: [] };
            }
            const buttons = [];
            markup.rows.forEach((rowEntry, row) => {
                rowEntry.buttons.forEach((button, col) => {
                    buttons.push(describeKeyboardButton(button, row, col));
                });
            });
            return { markupType: markup.className, buttons };
        }, `getMessageButtons ${chatId}/${messageId}`);
    }
    async getBroadcastStats(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Broadcast stats are only available for channels");
            }
            if (entity.megagroup) {
                throw new Error("Broadcast stats are only available for broadcast channels, not supergroups (use telegram-get-megagroup-stats)");
            }
            let result;
            try {
                const response = await this.client?.invoke(new Api.stats.GetBroadcastStats({ channel: entity, dark: options?.dark }));
                if (!response) {
                    throw new Error("channel has no stats (may require Telegram Premium admin)");
                }
                result = response;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (/CHAT_ADMIN_REQUIRED|ADMIN_RANK_INVALID/i.test(msg)) {
                    throw new Error("Access denied: channel stats require admin rights (and may require Telegram Premium)");
                }
                if (/STATS_UNAVAILABLE|BROADCAST_REQUIRED|PARTICIPANTS_TOO_FEW/i.test(msg)) {
                    throw new Error("channel has no stats (may require Telegram Premium admin)");
                }
                throw e;
            }
            return summarizeBroadcastStats(result, options?.includeGraphs === true);
        }, `getBroadcastStats ${chatId}`);
    }
    async getMegagroupStats(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Megagroup stats are only available for supergroups");
            }
            if (!entity.megagroup) {
                throw new Error("Megagroup stats are only available for supergroups, not broadcast channels (use telegram-get-broadcast-stats)");
            }
            let result;
            try {
                const response = await this.client?.invoke(new Api.stats.GetMegagroupStats({ channel: entity, dark: options?.dark }));
                if (!response) {
                    throw new Error("supergroup has no stats yet (needs more activity/members)");
                }
                result = response;
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (/CHAT_ADMIN_REQUIRED|ADMIN_RANK_INVALID/i.test(msg)) {
                    throw new Error("Access denied: supergroup stats require admin rights");
                }
                if (/STATS_UNAVAILABLE|PARTICIPANTS_TOO_FEW|MEGAGROUP_REQUIRED/i.test(msg)) {
                    throw new Error("supergroup has no stats yet (needs more activity/members)");
                }
                throw e;
            }
            return summarizeMegagroupStats(result, options?.includeGraphs === true);
        }, `getMegagroupStats ${chatId}`, { throwOnFloodWait: true });
    }
    // ─── Stats & updates ───────────────────────────────────────────────────────
    async getUpdatesState() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const state = await this.client?.invoke(new Api.updates.GetState());
            if (!state)
                throw new Error("updates.GetState returned no state");
            return {
                pts: state.pts,
                qts: state.qts,
                date: state.date,
                seq: state.seq,
                unreadCount: state.unreadCount,
            };
        }, "getUpdatesState");
    }
    async getUpdates(cursor) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const ptsLimit = Math.min(cursor.ptsLimit ?? 100, 1000);
        const ptsTotalLimit = Math.min(cursor.ptsTotalLimit ?? 1000, 1000);
        return this.rateLimiter.execute(async () => {
            const diff = await this.client?.invoke(new Api.updates.GetDifference({
                pts: cursor.pts,
                date: cursor.date,
                qts: cursor.qts,
                ptsLimit,
                ptsTotalLimit,
            }));
            if (!diff)
                throw new Error("updates.GetDifference returned nothing");
            return summarizeUpdatesDifference(diff, cursor);
        }, "getUpdates");
    }
    async getChannelUpdates(chatId, cursor) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const limit = Math.min(cursor.limit ?? 100, 1_000);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel)) {
                throw new Error("Channel updates are only available for channels/supergroups");
            }
            const diff = await this.client?.invoke(new Api.updates.GetChannelDifference({
                channel: entity,
                filter: new Api.ChannelMessagesFilterEmpty(),
                pts: cursor.pts,
                limit,
                force: cursor.force,
            }));
            if (!diff)
                throw new Error("updates.GetChannelDifference returned nothing");
            return summarizeChannelDifference(diff, entity.id.toString(), cursor.pts);
        }, `getChannelUpdates ${chatId}`);
    }
    // ─── Forum topics ──────────────────────────────────────────────────────────
    async createForumTopic(chatId, title, iconColor, iconEmojiId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            const randomId = bigInt(Math.floor(Math.random() * 1e15));
            const result = await this.client?.invoke(new Api.channels.CreateForumTopic({
                channel: entity,
                title,
                iconColor,
                iconEmojiId: iconEmojiId ? bigInt(iconEmojiId) : undefined,
                randomId,
            }));
            let topicId = 0;
            if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
                for (const update of result.updates) {
                    if (update instanceof Api.UpdateNewChannelMessage &&
                        update.message instanceof Api.MessageService &&
                        update.message.action instanceof Api.MessageActionTopicCreate) {
                        topicId = update.message.id;
                        break;
                    }
                }
                if (topicId === 0) {
                    for (const update of result.updates) {
                        if (update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId)) {
                            topicId = update.id;
                            break;
                        }
                    }
                }
            }
            if (topicId === 0) {
                throw new Error("Failed to determine created topic ID");
            }
            return { id: topicId, title };
        }, `createForumTopic ${chatId}`);
    }
    async editForumTopic(chatId, topicId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.EditForumTopic({
                channel: entity,
                topicId,
                title: options.title,
                iconEmojiId: options.iconEmojiId ? bigInt(options.iconEmojiId) : undefined,
                closed: options.closed,
                hidden: options.hidden,
            }));
        }, `editForumTopic ${chatId}/${topicId}`);
    }
    // Telegram MCP Starter (M14): закрепление темы форума. В апстриме тему можно создать,
    // переименовать и удалить, а закрепить — нечем; при этом закреплённые темы это
    // первое, что видит человек, открывший группу потока.
    async pinForumTopic(chatId, topicId, pinned = true) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.UpdatePinnedForumTopic({
                channel: entity,
                topicId,
                pinned,
            }));
        }, `pinForumTopic ${chatId}/${topicId}`);
    }
    // Telegram MCP Starter (M14): порядок закреплённых. UpdatePinnedForumTopic кладёт свежую
    // тему НАВЕРХ списка, поэтому «закрепить те же и в том же порядке» одним лишь
    // закреплением не выражается — нужен явный порядок сверху вниз.
    // force=true доснимает закрепление с тем, которых нет в списке; по умолчанию false,
    // чтобы вызов не разбирал чужие закрепления молча.
    async reorderPinnedForumTopics(chatId, order, force = false) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.ReorderPinnedForumTopics({
                channel: entity,
                order,
                force,
            }));
        }, `reorderPinnedForumTopics ${chatId}`);
    }
    async deleteForumTopic(chatId, topicId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const entity = await this.resolveChat(chatId);
            if (!(entity instanceof Api.Channel) || !entity.forum) {
                throw new Error("Forum topics are only available in forum supergroups");
            }
            await this.client?.invoke(new Api.channels.DeleteTopicHistory({
                channel: entity,
                topMsgId: topicId,
            }));
        }, `deleteForumTopic ${chatId}/${topicId}`);
    }
    // ─── Invite links & folders ────────────────────────────────────────────────
    // Telegram MCP Starter (M16): замена ПЕРВИЧНОЙ ссылки чата. Отзыв ссылки закрытую
    // группу не закрывает: первичная ссылка есть у чата всегда, и сразу после
    // отзыва Telegram выдаёт новую — без подтверждения заявок. Единственный
    // способ поставить заявки на неё — флаг legacy_revoke_permanent у
    // messages.ExportChatInvite: тем же вызовом старая первичная отзывается,
    // новая создаётся с нужными настройками.
    // Возвращается не одна строка, а флаги из ответа сервера: requestNeeded и
    // title Telegram для первичной ссылки может проигнорировать молча, и
    // проверить это больше нечем.
    async exportInviteLink(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const result = await this.client.invoke(new Api.messages.ExportChatInvite({
            peer,
            expireDate: options?.expireDate,
            usageLimit: options?.usageLimit,
            requestNeeded: options?.requestNeeded,
            title: options?.title,
            legacyRevokePermanent: options?.replacePrimary,
        }));
        if (result instanceof Api.ChatInviteExported) {
            return {
                link: result.link,
                title: result.title,
                permanent: result.permanent ?? false,
                requestNeeded: result.requestNeeded ?? false,
            };
        }
        throw new Error("Failed to export invite link");
    }
    async getInviteLinks(chatId, limit = 20, adminId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        const admin = adminId ? await this.client.getInputEntity(await this.resolvePeer(adminId)) : new Api.InputUserSelf();
        const result = await this.client.invoke(new Api.messages.GetExportedChatInvites({
            peer,
            adminId: admin,
            limit,
        }));
        return result.invites
            .filter((inv) => inv instanceof Api.ChatInviteExported)
            .map((inv) => {
            const expiredByDate = inv.expireDate ? inv.expireDate < Math.floor(Date.now() / 1000) : false;
            const expiredByUsage = inv.usageLimit != null && inv.usageLimit > 0 && inv.usage != null ? inv.usage >= inv.usageLimit : false;
            return {
                link: inv.link,
                title: inv.title,
                expired: expiredByDate || expiredByUsage,
                revoked: inv.revoked ?? false,
                usageCount: inv.usage ?? 0,
                // Telegram MCP Starter (M16): без этих двух флагов список ссылок не
                // отвечал на главный вопрос закрытой группы — какая из ссылок
                // первичная и можно ли по ней войти без заявки.
                permanent: inv.permanent ?? false,
                requestNeeded: inv.requestNeeded ?? false,
            };
        });
    }
    async revokeInviteLink(chatId, link) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.messages.EditExportedChatInvite({
            peer,
            link,
            revoked: true,
        }));
    }
    async getChatFolders() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetDialogFilters());
        const filters = "filters" in result ? result.filters : [];
        return filters
            .filter((f) => f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist)
            .map((f) => ({
            id: f.id,
            title: typeof f.title === "string" ? f.title : f.title.text,
            emoticon: f.emoticon,
            pinnedCount: f.pinnedPeers?.length ?? 0,
            includeCount: f.includePeers?.length ?? 0,
        }));
    }
    async setAutoDelete(chatId, period) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const resolved = await this.resolvePeer(chatId);
        const peer = await this.client.getInputEntity(resolved);
        await this.client.invoke(new Api.messages.SetHistoryTTL({ peer, period }));
    }
    // ─── Folder management (v1.33.0) ───────────────────────────────────────────
    async createFolder(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const filtersResult = await client.invoke(new Api.messages.GetDialogFilters());
        const existing = "filters" in filtersResult ? filtersResult.filters : [];
        const usedIds = existing
            .filter((f) => "id" in f)
            .map((f) => f.id);
        let newId = 2;
        while (usedIds.includes(newId))
            newId++;
        const toInput = async (ids) => {
            const peers = [];
            for (const id of ids) {
                const resolved = await this.resolvePeer(id);
                peers.push(await client.getInputEntity(resolved));
            }
            return peers;
        };
        const includePeers = await toInput(opts.includePeers ?? []);
        const excludePeers = await toInput(opts.excludePeers ?? []);
        const pinnedPeers = await toInput(opts.pinnedPeers ?? []);
        await client.invoke(new Api.messages.UpdateDialogFilter({
            id: newId,
            filter: new Api.DialogFilter({
                id: newId,
                title: new Api.TextWithEntities({ text: opts.title, entities: [] }),
                emoticon: opts.emoticon,
                contacts: opts.contacts,
                nonContacts: opts.nonContacts,
                groups: opts.groups,
                broadcasts: opts.broadcasts,
                bots: opts.bots,
                excludeMuted: opts.excludeMuted,
                excludeRead: opts.excludeRead,
                excludeArchived: opts.excludeArchived,
                pinnedPeers,
                includePeers,
                excludePeers,
            }),
        }));
        return newId;
    }
    async editFolder(id, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const filtersResult = await client.invoke(new Api.messages.GetDialogFilters());
        const existing = "filters" in filtersResult ? filtersResult.filters : [];
        const current = existing.find((f) => f instanceof Api.DialogFilter && f.id === id);
        if (!current)
            throw new Error(`Folder with id=${id} not found`);
        const toInput = async (ids) => {
            const peers = [];
            for (const id of ids) {
                const resolved = await this.resolvePeer(id);
                peers.push(await client.getInputEntity(resolved));
            }
            return peers;
        };
        const includePeers = opts.includePeers !== undefined ? await toInput(opts.includePeers) : current.includePeers;
        const excludePeers = opts.excludePeers !== undefined ? await toInput(opts.excludePeers) : current.excludePeers;
        const pinnedPeers = opts.pinnedPeers !== undefined ? await toInput(opts.pinnedPeers) : current.pinnedPeers;
        const titleText = opts.title !== undefined ? opts.title : typeof current.title === "string" ? current.title : current.title.text;
        await client.invoke(new Api.messages.UpdateDialogFilter({
            id,
            filter: new Api.DialogFilter({
                id,
                title: new Api.TextWithEntities({ text: titleText, entities: [] }),
                emoticon: opts.emoticon !== undefined ? opts.emoticon : current.emoticon,
                contacts: opts.contacts !== undefined ? opts.contacts : current.contacts,
                nonContacts: opts.nonContacts !== undefined ? opts.nonContacts : current.nonContacts,
                groups: opts.groups !== undefined ? opts.groups : current.groups,
                broadcasts: opts.broadcasts !== undefined ? opts.broadcasts : current.broadcasts,
                bots: opts.bots !== undefined ? opts.bots : current.bots,
                excludeMuted: opts.excludeMuted !== undefined ? opts.excludeMuted : current.excludeMuted,
                excludeRead: opts.excludeRead !== undefined ? opts.excludeRead : current.excludeRead,
                excludeArchived: opts.excludeArchived !== undefined ? opts.excludeArchived : current.excludeArchived,
                pinnedPeers,
                includePeers,
                excludePeers,
            }),
        }));
    }
    async deleteFolder(id) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.UpdateDialogFilter({ id }));
    }
    async reorderFolders(ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.UpdateDialogFiltersOrder({ order: ids }));
    }
    async getSuggestedFolders() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetSuggestedDialogFilters());
        return result
            .filter((s) => s.filter instanceof Api.DialogFilter || s.filter instanceof Api.DialogFilterChatlist)
            .map((s) => ({
            title: typeof s.filter.title === "string" ? s.filter.title : s.filter.title.text,
            emoticon: s.filter.emoticon,
        }));
    }
    async toggleDialogFilterTags(enabled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.messages.ToggleDialogFilterTags({ enabled }));
    }
    // ─── Global privacy (v1.33.0) ──────────────────────────────────────────────
    async getGlobalPrivacySettings() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const s = await this.client.invoke(new Api.account.GetGlobalPrivacySettings());
        return {
            archiveAndMuteNewNoncontactPeers: s.archiveAndMuteNewNoncontactPeers ?? false,
            keepArchivedUnmuted: s.keepArchivedUnmuted ?? false,
            keepArchivedFolders: s.keepArchivedFolders ?? false,
            hideReadMarks: s.hideReadMarks ?? false,
            newNoncontactPeersRequirePremium: s.newNoncontactPeersRequirePremium ?? false,
        };
    }
    async setGlobalPrivacySettings(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const current = await this.client.invoke(new Api.account.GetGlobalPrivacySettings());
        await this.client.invoke(new Api.account.SetGlobalPrivacySettings({
            settings: new Api.GlobalPrivacySettings({
                archiveAndMuteNewNoncontactPeers: opts.archiveAndMuteNewNoncontactPeers ?? current.archiveAndMuteNewNoncontactPeers,
                keepArchivedUnmuted: opts.keepArchivedUnmuted ?? current.keepArchivedUnmuted,
                keepArchivedFolders: opts.keepArchivedFolders ?? current.keepArchivedFolders,
                hideReadMarks: opts.hideReadMarks ?? current.hideReadMarks,
                newNoncontactPeersRequirePremium: opts.newNoncontactPeersRequirePremium ?? current.newNoncontactPeersRequirePremium,
            }),
        }));
    }
    // ─── Account & privacy ─────────────────────────────────────────────────────
    async getActiveSessions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.account.GetAuthorizations());
        return result.authorizations.map((a) => ({
            hash: a.hash.toString(),
            device: a.deviceModel,
            platform: a.platform,
            appName: a.appName,
            appVersion: a.appVersion,
            ip: a.ip,
            country: a.country,
            dateActive: new Date(a.dateActive * 1000).toISOString(),
            current: a.current ?? false,
        }));
    }
    async terminateSession(hash) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.ResetAuthorization({ hash: bigInt(hash) }));
    }
    async terminateAllOtherSessions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.auth.ResetAuthorizations());
    }
    static PRIVACY_KEYS = {
        phone_number: () => new Api.InputPrivacyKeyPhoneNumber(),
        last_seen: () => new Api.InputPrivacyKeyStatusTimestamp(),
        profile_photo: () => new Api.InputPrivacyKeyProfilePhoto(),
        forwards: () => new Api.InputPrivacyKeyForwards(),
        calls: () => new Api.InputPrivacyKeyPhoneCall(),
        groups: () => new Api.InputPrivacyKeyChatInvite(),
        bio: () => new Api.InputPrivacyKeyAbout(),
    };
    async setPrivacy(setting, rule, allowUsers, disallowUsers) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const keyFactory = TelegramService.PRIVACY_KEYS[setting];
        if (!keyFactory)
            throw new Error(`Unknown privacy setting: ${setting}. Valid: ${Object.keys(TelegramService.PRIVACY_KEYS).join(", ")}`);
        const rules = [];
        // Exceptions must come before the general rule so they are not shadowed
        if (disallowUsers?.length) {
            const users = [];
            const invalid = [];
            for (const u of disallowUsers) {
                const inputEntity = await this.client.getInputEntity(u);
                if (inputEntity instanceof Api.InputPeerUser) {
                    users.push(new Api.InputUser({ userId: inputEntity.userId, accessHash: inputEntity.accessHash }));
                }
                else {
                    invalid.push(u);
                }
            }
            if (invalid.length > 0) {
                throw new Error(`disallowUsers entries are not valid users: ${invalid.join(", ")}`);
            }
            if (users.length > 0) {
                rules.push(new Api.InputPrivacyValueDisallowUsers({ users }));
            }
        }
        if (allowUsers?.length) {
            const users = [];
            const invalid = [];
            for (const u of allowUsers) {
                const inputEntity = await this.client.getInputEntity(u);
                if (inputEntity instanceof Api.InputPeerUser) {
                    users.push(new Api.InputUser({ userId: inputEntity.userId, accessHash: inputEntity.accessHash }));
                }
                else {
                    invalid.push(u);
                }
            }
            if (invalid.length > 0) {
                throw new Error(`allowUsers entries are not valid users: ${invalid.join(", ")}`);
            }
            if (users.length > 0) {
                rules.push(new Api.InputPrivacyValueAllowUsers({ users }));
            }
        }
        if (rule === "everyone")
            rules.push(new Api.InputPrivacyValueAllowAll());
        else if (rule === "contacts")
            rules.push(new Api.InputPrivacyValueAllowContacts(), new Api.InputPrivacyValueDisallowAll());
        else
            rules.push(new Api.InputPrivacyValueDisallowAll());
        await this.client.invoke(new Api.account.SetPrivacy({ key: keyFactory(), rules }));
    }
    async updateProfile(options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.UpdateProfile({
            firstName: options.firstName,
            lastName: options.lastName,
            about: options.bio,
        }));
    }
    async updateUsername(username) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.client.invoke(new Api.account.UpdateUsername({ username }));
    }
    // ─── Stickers ──────────────────────────────────────────────────────────────
    async getStickerSet(shortName) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({ shortName }),
            hash: 0,
        }));
        if (result instanceof Api.messages.StickerSetNotModified) {
            throw new Error("Sticker set was not modified");
        }
        const set = result.set;
        const packs = result.packs;
        // Build emoji map: document id -> emoji
        const emojiMap = new Map();
        for (const pack of packs) {
            for (const docId of pack.documents) {
                emojiMap.set(docId.toString(), pack.emoticon);
            }
        }
        return {
            title: set.title,
            shortName: set.shortName,
            count: set.count,
            stickers: result.documents.map((doc) => ({
                id: doc.id.toString(),
                accessHash: doc.accessHash.toString(),
                emoji: emojiMap.get(doc.id.toString()) || "",
            })),
        };
    }
    async searchStickerSets(query) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.SearchStickerSets({
            q: query,
            hash: bigInt(0),
        }));
        if (result instanceof Api.messages.FoundStickerSetsNotModified) {
            return [];
        }
        return result.sets.map((covered) => {
            const set = covered.set;
            return {
                title: set.title,
                shortName: set.shortName,
                count: set.count,
            };
        });
    }
    async getInstalledStickerSets() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetAllStickers({ hash: bigInt(0) }));
        if (result instanceof Api.messages.AllStickersNotModified) {
            return [];
        }
        return result.sets.map((set) => ({
            title: set.title,
            shortName: set.shortName,
            count: set.count,
        }));
    }
    async sendSticker(chatId, stickerSetShortName, stickerIndex, replyTo) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return await this.rateLimiter.execute(async () => {
            if (!Number.isInteger(stickerIndex)) {
                throw new Error(`Sticker index must be an integer, got ${stickerIndex}`);
            }
            // Fetch raw sticker set to get the actual Api.Document with valid fileReference
            const rawResult = await this.client?.invoke(new Api.messages.GetStickerSet({
                stickerset: new Api.InputStickerSetShortName({ shortName: stickerSetShortName }),
                hash: 0,
            }));
            if (!rawResult || rawResult instanceof Api.messages.StickerSetNotModified) {
                throw new Error("Sticker set not found");
            }
            const stickerSet = rawResult;
            if (stickerIndex < 0 || stickerIndex >= stickerSet.documents.length) {
                throw new Error(`Sticker index ${stickerIndex} out of range (0-${stickerSet.documents.length - 1})`);
            }
            const sticker = stickerSet.documents[stickerIndex];
            if (!(sticker instanceof Api.Document)) {
                throw new Error("Selected sticker is not a valid document");
            }
            const resolved = await this.resolvePeer(chatId);
            return await this.client?.sendFile(resolved, {
                file: sticker,
                ...(replyTo ? { replyTo } : {}),
            });
        }, `sendSticker to ${chatId}`);
    }
    // ─── Drafts & saved dialogs ────────────────────────────────────────────────
    async saveDraft(chatId, text, replyTo) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            const resolved = await this.resolvePeer(chatId);
            const peer = await this.client?.getInputEntity(resolved);
            if (!peer)
                throw new Error(`Cannot resolve peer for ${chatId}`);
            const effectiveReplyTo = text === "" ? undefined : replyTo;
            await this.client?.invoke(new Api.messages.SaveDraft({
                peer,
                message: text,
                ...(effectiveReplyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: effectiveReplyTo }) } : {}),
            }));
        }, `saveDraft in ${chatId}`);
    }
    async getAllDrafts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetAllDrafts());
            if (!result)
                return [];
            const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
            const users = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.users : [];
            const chats = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.chats : [];
            const userMap = new Map();
            for (const u of users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const chatMap = new Map();
            for (const c of chats) {
                if (c instanceof Api.Chat || c instanceof Api.Channel)
                    chatMap.set(c.id.toString(), c);
            }
            const resolvePeerTitle = (peer) => {
                if (peer instanceof Api.PeerUser) {
                    const user = userMap.get(peer.userId.toString());
                    if (user) {
                        const parts = [user.firstName, user.lastName].filter(Boolean);
                        const name = parts.join(" ") || "Unknown";
                        return {
                            id: peer.userId.toString(),
                            title: user.username ? `${name} (@${user.username})` : name,
                        };
                    }
                    return { id: peer.userId.toString(), title: peer.userId.toString() };
                }
                if (peer instanceof Api.PeerChat) {
                    const chat = chatMap.get(peer.chatId.toString());
                    return {
                        id: peer.chatId.toString(),
                        title: chat?.title ?? peer.chatId.toString(),
                    };
                }
                if (peer instanceof Api.PeerChannel) {
                    const channel = chatMap.get(peer.channelId.toString());
                    return {
                        id: peer.channelId.toString(),
                        title: channel?.title ?? peer.channelId.toString(),
                    };
                }
                return { id: "unknown", title: "unknown" };
            };
            const drafts = [];
            for (const update of updates) {
                if (update instanceof Api.UpdateDraftMessage && update.draft instanceof Api.DraftMessage) {
                    const { id, title } = resolvePeerTitle(update.peer);
                    drafts.push({
                        chatId: id,
                        chatTitle: title,
                        text: update.draft.message ?? "",
                        date: new Date((update.draft.date ?? 0) * 1000).toISOString(),
                    });
                }
            }
            return drafts;
        }, "getAllDrafts");
    }
    async clearAllDrafts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        await this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.messages.ClearAllDrafts());
        }, "clearAllDrafts");
    }
    async getSavedDialogs(limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetSavedDialogs({
                offsetDate: 0,
                offsetId: 0,
                offsetPeer: new Api.InputPeerEmpty(),
                limit,
                hash: bigInt(0),
            }));
            if (!result || result instanceof Api.messages.SavedDialogsNotModified)
                return [];
            const userMap = new Map();
            for (const u of result.users) {
                if (u instanceof Api.User)
                    userMap.set(u.id.toString(), u);
            }
            const chatMap = new Map();
            for (const c of result.chats) {
                if (c instanceof Api.Chat || c instanceof Api.Channel)
                    chatMap.set(c.id.toString(), c);
            }
            const resolvePeerTitle = (peer) => {
                if (peer instanceof Api.PeerUser) {
                    const user = userMap.get(peer.userId.toString());
                    if (user) {
                        const parts = [user.firstName, user.lastName].filter(Boolean);
                        const name = parts.join(" ") || "Unknown";
                        return {
                            id: peer.userId.toString(),
                            title: user.username ? `${name} (@${user.username})` : name,
                        };
                    }
                    return { id: peer.userId.toString(), title: peer.userId.toString() };
                }
                if (peer instanceof Api.PeerChat) {
                    const chat = chatMap.get(peer.chatId.toString());
                    return { id: peer.chatId.toString(), title: chat?.title ?? peer.chatId.toString() };
                }
                if (peer instanceof Api.PeerChannel) {
                    const channel = chatMap.get(peer.channelId.toString());
                    return { id: peer.channelId.toString(), title: channel?.title ?? peer.channelId.toString() };
                }
                return { id: "unknown", title: "unknown" };
            };
            const dialogs = [];
            for (const d of result.dialogs) {
                if (d instanceof Api.SavedDialog) {
                    const { id, title } = resolvePeerTitle(d.peer);
                    dialogs.push({
                        peerId: id,
                        peerTitle: title,
                        lastMsgId: d.topMessage,
                    });
                }
            }
            return dialogs;
        }, "getSavedDialogs");
    }
    async getWebPreview(url) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetWebPagePreview({ message: url }));
            if (!result)
                return null;
            const media = result.media;
            if (!(media instanceof Api.MessageMediaWebPage))
                return null;
            const page = media.webpage;
            if (page instanceof Api.WebPageEmpty) {
                return { type: "empty", url: page.url };
            }
            if (page instanceof Api.WebPagePending) {
                return { type: "pending", url: page.url };
            }
            if (page instanceof Api.WebPage) {
                return {
                    type: page.type ?? "article",
                    url: page.url,
                    title: page.title,
                    description: page.description,
                    siteName: page.siteName,
                };
            }
            return null;
        }, "getWebPreview");
    }
    async getRecentStickers() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.messages.GetRecentStickers({ hash: bigInt(0) }));
        if (result instanceof Api.messages.RecentStickersNotModified) {
            return [];
        }
        const emojiMap = new Map();
        for (const pack of result.packs) {
            for (const docId of pack.documents) {
                emojiMap.set(docId.toString(), pack.emoticon);
            }
        }
        return result.stickers.map((doc) => ({
            id: doc.id.toString(),
            accessHash: doc.accessHash.toString(),
            emoji: emojiMap.get(doc.id.toString()) || "",
        }));
    }
    // ─── Stories ───────────────────────────────────────────────────────────────
    async getAllStories(options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetAllStories({
                next: options?.next,
                hidden: options?.hidden,
                state: options?.state,
            }));
            if (!response)
                throw new Error("stories.GetAllStories returned nothing");
            return summarizeAllStories(response);
        }, "getAllStories");
    }
    async getPeerStories(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetPeerStories({ peer }));
            if (!response)
                throw new Error("stories.GetPeerStories returned nothing");
            return summarizePeerStories(response.stories);
        }, `getPeerStories ${chatId}`);
    }
    async getStoriesById(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetStoriesByID({ peer, id: ids }));
            if (!response)
                throw new Error("stories.GetStoriesByID returned nothing");
            return summarizeStoriesById(response);
        }, `getStoriesById ${chatId}`);
    }
    async getStoryViewsList(chatId, options) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.stories.GetStoryViewsList({
                peer,
                id: options.id,
                q: options.q,
                justContacts: options.justContacts,
                reactionsFirst: options.reactionsFirst,
                forwardsFirst: options.forwardsFirst,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("stories.GetStoryViewsList returned nothing");
            return summarizeStoryViewsList(response);
        }, `getStoryViewsList ${chatId}/${options.id}`);
    }
    // ─── Boosts ────────────────────────────────────────────────────────────────
    async getMyBoosts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetMyBoosts());
            if (!response)
                throw new Error("premium.GetMyBoosts returned nothing");
            return summarizeMyBoosts(response);
        }, "getMyBoosts");
    }
    async getBoostsStatus(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetBoostsStatus({ peer }));
            if (!response)
                throw new Error("premium.GetBoostsStatus returned nothing");
            return summarizeBoostsStatus(response);
        }, `getBoostsStatus ${chatId}`);
    }
    async getBoostsList(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.premium.GetBoostsList({
                peer,
                gifts: options.gifts,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("premium.GetBoostsList returned nothing");
            return summarizeBoostsList(response);
        }, `getBoostsList ${chatId}`);
    }
    async getBusinessChatLinks() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.account.GetBusinessChatLinks());
            if (!response)
                throw new Error("account.GetBusinessChatLinks returned nothing");
            return summarizeBusinessChatLinks(response);
        }, "getBusinessChatLinks");
    }
    // ─── Profile write (v1.32.0) ───────────────────────────────────────────────
    async setEmojiStatus(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            let emojiStatus;
            if (opts.collectibleId) {
                emojiStatus = new Api.InputEmojiStatusCollectible({
                    collectibleId: bigInt(opts.collectibleId),
                    until: opts.untilUnix,
                });
            }
            else if (opts.documentId) {
                emojiStatus = new Api.EmojiStatus({
                    documentId: bigInt(opts.documentId),
                    until: opts.untilUnix,
                });
            }
            else {
                emojiStatus = new Api.EmojiStatusEmpty();
            }
            await client.invoke(new Api.account.UpdateEmojiStatus({ emojiStatus }));
        }, "setEmojiStatus");
    }
    async listEmojiStatuses(kind, limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const hash = bigInt(0);
            let resp;
            if (kind === "recent") {
                resp = await client.invoke(new Api.account.GetRecentEmojiStatuses({ hash }));
            }
            else if (kind === "channel_default") {
                resp = await client.invoke(new Api.account.GetChannelDefaultEmojiStatuses({ hash }));
            }
            else if (kind === "collectible") {
                resp = await client.invoke(new Api.account.GetCollectibleEmojiStatuses({ hash }));
            }
            else {
                resp = await client.invoke(new Api.account.GetDefaultEmojiStatuses({ hash }));
            }
            if (resp.className === "account.EmojiStatusesNotModified")
                return [];
            const statuses = resp.statuses ?? [];
            return statuses.slice(0, limit).map(summarizeEmojiStatus);
        }, `listEmojiStatuses ${kind}`);
    }
    async clearRecentEmojiStatuses() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.ClearRecentEmojiStatuses());
        }, "clearRecentEmojiStatuses");
    }
    async setProfileColor(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.UpdateColor({
                forProfile: opts.forProfile || undefined,
                color: opts.color,
                backgroundEmojiId: opts.backgroundEmojiId ? bigInt(opts.backgroundEmojiId) : undefined,
            }));
        }, "setProfileColor");
    }
    async setBirthday(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const birthday = opts.clear || !opts.day || !opts.month
                ? undefined
                : new Api.Birthday({ day: opts.day, month: opts.month, year: opts.year });
            await client.invoke(new Api.account.UpdateBirthday({ birthday }));
        }, "setBirthday");
    }
    async setPersonalChannel(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdatePersonalChannel({ channel: new Api.InputChannelEmpty() }));
                return null;
            }
            const entity = await client.getInputEntity(opts.channelId ?? "");
            if (!(entity instanceof Api.InputPeerChannel)) {
                throw new Error(`Not a channel: ${opts.channelId}`);
            }
            const channel = new Api.InputChannel({
                channelId: entity.channelId,
                accessHash: entity.accessHash,
            });
            await client.invoke(new Api.account.UpdatePersonalChannel({ channel }));
            const info = await client.getEntity(entity);
            return "title" in info ? info.title : (opts.channelId ?? "");
        }, `setPersonalChannel ${opts.channelId ?? "clear"}`);
    }
    async setProfilePhoto(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const inputFile = await client.uploadFile({
                file: new CustomFile(opts.filePath.split("/").pop() ?? "upload", (await import("node:fs")).statSync(opts.filePath).size, opts.filePath),
                workers: 4,
            });
            const request = opts.isVideo
                ? new Api.photos.UploadProfilePhoto({
                    fallback: opts.fallback || undefined,
                    video: inputFile,
                    videoStartTs: opts.videoStartTs,
                })
                : new Api.photos.UploadProfilePhoto({
                    fallback: opts.fallback || undefined,
                    file: inputFile,
                });
            const result = await client.invoke(request);
            const photo = result.photo;
            return { id: photo.id.toString() };
        }, "setProfilePhoto");
    }
    async deleteProfilePhotos(photoIds) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const me = await client.getMe();
            const all = await client.invoke(new Api.photos.GetUserPhotos({
                userId: me.id,
                offset: 0,
                maxId: bigInt(0),
                limit: 100,
            }));
            const byId = new Map();
            for (const p of all.photos) {
                if (p instanceof Api.Photo)
                    byId.set(p.id.toString(), p);
            }
            const inputs = [];
            const missing = [];
            for (const pid of photoIds) {
                const photo = byId.get(pid);
                if (!photo) {
                    missing.push(pid);
                    continue;
                }
                inputs.push(new Api.InputPhoto({
                    id: photo.id,
                    accessHash: photo.accessHash,
                    fileReference: photo.fileReference,
                }));
            }
            if (inputs.length === 0) {
                throw new Error(`No matching photos found. Missing IDs: ${missing.join(", ")}`);
            }
            const deletedIds = await client.invoke(new Api.photos.DeletePhotos({ id: inputs }));
            return { deleted: deletedIds.map((x) => x.toString()), missing };
        }, "deleteProfilePhotos");
    }
    // ─── Business write (v1.32.0) ──────────────────────────────────────────────
    async buildBusinessRecipients(opts) {
        const flags = {};
        switch (opts.audience) {
            case "all_new":
                flags.contacts = true;
                flags.nonContacts = true;
                break;
            case "contacts_only":
                flags.contacts = true;
                break;
            case "non_contacts":
                flags.nonContacts = true;
                break;
            case "existing_only":
                flags.existingChats = true;
                break;
        }
        if (opts.includeUsers?.length) {
            flags.users = await this.resolveInputUsers(opts.includeUsers);
        }
        else if (opts.excludeUsers?.length) {
            flags.users = await this.resolveInputUsers(opts.excludeUsers);
            flags.excludeSelected = true;
        }
        return new Api.InputBusinessRecipients({ ...flags });
    }
    async resolveInputUsers(ids) {
        if (!this.client)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const result = [];
        for (const id of ids) {
            const entity = await client.getInputEntity(id);
            if (entity instanceof Api.InputPeerUser) {
                result.push(new Api.InputUser({ userId: entity.userId, accessHash: entity.accessHash }));
            }
            else {
                throw new Error(`Not a user: ${id}`);
            }
        }
        return result;
    }
    async parseEntities(text, parseMode) {
        if (!this.client || !parseMode)
            return { text };
        // biome-ignore lint/suspicious/noExplicitAny: internal GramJS API
        const parser = this.client._parseMessageText?.bind(this.client);
        if (!parser)
            return { text };
        const [parsedText, entities] = await parser(text, parseMode === "md" ? "markdown" : "html");
        return { text: parsedText, entities: entities?.length ? entities : undefined };
    }
    async setBusinessWorkHours(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessWorkHours({}));
                return;
            }
            const dayOffsets = {
                mon: 0,
                tue: 1,
                wed: 2,
                thu: 3,
                fri: 4,
                sat: 5,
                sun: 6,
            };
            const weeklyOpen = (opts.schedule ?? []).map((s) => {
                const [fh, fm] = s.openFrom.split(":").map(Number);
                const [th, tm] = s.openTo.split(":").map(Number);
                const base = (dayOffsets[s.day] ?? 0) * 1440;
                return new Api.BusinessWeeklyOpen({
                    startMinute: base + fh * 60 + fm,
                    endMinute: base + th * 60 + tm,
                });
            });
            await client.invoke(new Api.account.UpdateBusinessWorkHours({
                businessWorkHours: new Api.BusinessWorkHours({
                    openNow: opts.openNow,
                    timezoneId: opts.timezone ?? "",
                    weeklyOpen,
                }),
            }));
        }, "setBusinessWorkHours");
    }
    async setBusinessLocation(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessLocation({}));
                return;
            }
            const geoPoint = opts.latitude !== undefined && opts.longitude !== undefined
                ? new Api.InputGeoPoint({ lat: opts.latitude, long: opts.longitude })
                : undefined;
            await client.invoke(new Api.account.UpdateBusinessLocation({ geoPoint, address: opts.address }));
        }, "setBusinessLocation");
    }
    async setBusinessGreeting(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessGreetingMessage({}));
                return;
            }
            const recipients = await this.buildBusinessRecipients({
                audience: opts.audience,
                includeUsers: opts.includeUsers,
                excludeUsers: opts.excludeUsers,
            });
            await client.invoke(new Api.account.UpdateBusinessGreetingMessage({
                message: new Api.InputBusinessGreetingMessage({
                    shortcutId: opts.shortcutId ?? 0,
                    recipients,
                    noActivityDays: opts.noActivityDays,
                }),
            }));
        }, "setBusinessGreeting");
    }
    async setBusinessAway(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessAwayMessage({}));
                return;
            }
            const scheduleObj = opts.schedule === "always"
                ? new Api.BusinessAwayMessageScheduleAlways()
                : opts.schedule === "outside_hours"
                    ? new Api.BusinessAwayMessageScheduleOutsideWorkHours()
                    : new Api.BusinessAwayMessageScheduleCustom({
                        startDate: opts.customFrom ?? 0,
                        endDate: opts.customTo ?? 0,
                    });
            const recipients = await this.buildBusinessRecipients({
                audience: opts.audience,
                includeUsers: opts.includeUsers,
                excludeUsers: opts.excludeUsers,
            });
            await client.invoke(new Api.account.UpdateBusinessAwayMessage({
                message: new Api.InputBusinessAwayMessage({
                    offlineOnly: opts.offlineOnly || undefined,
                    shortcutId: opts.shortcutId ?? 0,
                    schedule: scheduleObj,
                    recipients,
                }),
            }));
        }, "setBusinessAway");
    }
    async setBusinessIntro(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            if (opts.clear) {
                await client.invoke(new Api.account.UpdateBusinessIntro({}));
                return;
            }
            const sticker = opts.stickerId && opts.stickerAccessHash && opts.stickerFileReference
                ? new Api.InputDocument({
                    id: bigInt(opts.stickerId),
                    accessHash: bigInt(opts.stickerAccessHash),
                    fileReference: Buffer.from(opts.stickerFileReference, "hex"),
                })
                : undefined;
            await client.invoke(new Api.account.UpdateBusinessIntro({
                intro: new Api.InputBusinessIntro({
                    title: opts.title ?? "",
                    description: opts.description ?? "",
                    sticker,
                }),
            }));
        }, "setBusinessIntro");
    }
    async createBusinessChatLink(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const { text, entities } = await this.parseEntities(opts.message, opts.parseMode);
            const result = await client.invoke(new Api.account.CreateBusinessChatLink({
                link: new Api.InputBusinessChatLink({
                    message: text,
                    entities,
                    title: opts.title,
                }),
            }));
            const summary = summarizeBusinessChatLink(result);
            const slug = result.link.split("/").pop() ?? "";
            return { ...summary, slug };
        }, "createBusinessChatLink");
    }
    async editBusinessChatLink(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const { text, entities } = await this.parseEntities(opts.message, opts.parseMode);
            const result = await client.invoke(new Api.account.EditBusinessChatLink({
                slug: opts.slug,
                link: new Api.InputBusinessChatLink({
                    message: text,
                    entities,
                    title: opts.title,
                }),
            }));
            return summarizeBusinessChatLink(result);
        }, `editBusinessChatLink ${opts.slug}`);
    }
    async deleteBusinessChatLink(slug) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            await client.invoke(new Api.account.DeleteBusinessChatLink({ slug }));
        }, `deleteBusinessChatLink ${slug}`);
    }
    async resolveBusinessChatLink(slug) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        return this.rateLimiter.execute(async () => {
            const result = await client.invoke(new Api.account.ResolveBusinessChatLink({ slug }));
            const r = result;
            return {
                peer: summarizePeer(r.peer),
                message: r.message,
                entityCount: r.entities?.length ?? 0,
            };
        }, `resolveBusinessChatLink ${slug}`);
    }
    // ─── Group calls ───────────────────────────────────────────────────────────
    async getGroupCall(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const call = await this.resolveInputGroupCall(chatId);
            const response = await this.client?.invoke(new Api.phone.GetGroupCall({ call, limit: options.limit ?? 0 }));
            if (!response)
                throw new Error("phone.GetGroupCall returned nothing");
            return summarizeGroupCall(response);
        }, `getGroupCall ${chatId}`);
    }
    async getGroupCallParticipants(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const call = await this.resolveInputGroupCall(chatId);
            const ids = [];
            for (const id of options.ids ?? []) {
                ids.push(await this.resolvePeer(id));
            }
            const response = await this.client?.invoke(new Api.phone.GetGroupParticipants({
                call,
                ids,
                sources: options.sources ?? [],
                offset: options.offset ?? "",
                limit: options.limit ?? 100,
            }));
            if (!response)
                throw new Error("phone.GetGroupParticipants returned nothing");
            return summarizeGroupCallParticipants(response);
        }, `getGroupCallParticipants ${chatId}`);
    }
    // ─── Stars ─────────────────────────────────────────────────────────────────
    async getStarsStatus(chatId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.payments.GetStarsStatus({ peer }));
            if (!response)
                throw new Error("payments.GetStarsStatus returned nothing");
            return summarizeStarsStatus(response);
        }, `getStarsStatus ${chatId}`);
    }
    async getStarsTransactions(chatId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.payments.GetStarsTransactions({
                peer,
                inbound: options.inbound,
                outbound: options.outbound,
                ascending: options.ascending,
                subscriptionId: options.subscriptionId,
                offset: options.offset ?? "",
                limit: options.limit ?? 50,
            }));
            if (!response)
                throw new Error("payments.GetStarsTransactions returned nothing");
            return summarizeStarsStatus(response);
        }, `getStarsTransactions ${chatId}`);
    }
    // ─── Star Gifts (v1.34.0) ──────────────────────────────────────────────────
    async getAvailableStarGifts() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
        if (result.className === "payments.StarGiftsNotModified")
            return [];
        const gifts = result.className === "payments.StarGifts" ? result.gifts : [];
        return gifts
            .filter((g) => g instanceof Api.StarGift)
            .map((g) => ({
            id: g.id.toString(),
            stars: g.stars.toString(),
            convertStars: g.convertStars.toString(),
            limited: g.limited ?? false,
            availabilityRemains: g.availabilityRemains,
            availabilityTotal: g.availabilityTotal,
            upgradeStars: g.upgradeStars?.toString(),
        }));
    }
    async getSavedStarGifts(chatId, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        const resolved = await client.getInputEntity(peer);
        const result = await client.invoke(new Api.payments.GetSavedStarGifts({
            peer: resolved,
            offset: opts.offset ?? "",
            limit: opts.limit ?? 20,
            excludeUnsaved: opts.excludeUnsaved,
            excludeSaved: opts.excludeSaved,
            excludeUnlimited: opts.excludeUnlimited,
            excludeLimited: opts.excludeLimited,
            excludeUnique: opts.excludeUnique,
            sortByValue: opts.sortByValue,
        }));
        const r = result;
        return {
            count: r.count,
            nextOffset: r.nextOffset,
            gifts: r.gifts.map((sg) => {
                const gift = sg.gift;
                if (gift instanceof Api.StarGift) {
                    return {
                        giftId: gift.id.toString(),
                        giftKind: "regular",
                        stars: gift.stars.toString(),
                        convertStars: gift.convertStars.toString(),
                        msgId: sg.msgId ?? undefined,
                        savedId: sg.savedId?.toString(),
                        fromPeerId: sg.fromId ? summarizePeer(sg.fromId).id : undefined,
                        date: sg.date,
                        unsaved: sg.unsaved ?? false,
                        canUpgrade: sg.canUpgrade ?? false,
                        upgradeStars: sg.upgradeStars?.toString(),
                    };
                }
                const u = gift;
                return {
                    giftId: u.id.toString(),
                    giftKind: "unique",
                    giftTitle: u.title,
                    msgId: sg.msgId ?? undefined,
                    savedId: sg.savedId?.toString(),
                    fromPeerId: sg.fromId ? summarizePeer(sg.fromId).id : undefined,
                    date: sg.date,
                    unsaved: sg.unsaved ?? false,
                    canUpgrade: false,
                };
            }),
        };
    }
    async saveStarGift(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        let stargift;
        if (opts.msgId !== undefined) {
            stargift = new Api.InputSavedStarGiftUser({ msgId: opts.msgId });
        }
        else if (opts.chatId && opts.savedId) {
            const peer = await this.resolvePeer(opts.chatId);
            const inputPeer = await client.getInputEntity(peer);
            stargift = new Api.InputSavedStarGiftChat({ peer: inputPeer, savedId: bigInt(opts.savedId) });
        }
        else {
            throw new Error("Provide msgId (user gift) or both chatId and savedId (chat gift)");
        }
        await client.invoke(new Api.payments.SaveStarGift({ stargift, unsave: opts.unsave }));
    }
    async convertStarGift(opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        let stargift;
        if (opts.msgId !== undefined) {
            stargift = new Api.InputSavedStarGiftUser({ msgId: opts.msgId });
        }
        else if (opts.chatId && opts.savedId) {
            const peer = await this.resolvePeer(opts.chatId);
            const inputPeer = await client.getInputEntity(peer);
            stargift = new Api.InputSavedStarGiftChat({ peer: inputPeer, savedId: bigInt(opts.savedId) });
        }
        else {
            throw new Error("Provide msgId (user gift) or both chatId and savedId (chat gift)");
        }
        await client.invoke(new Api.payments.ConvertStarGift({ stargift }));
    }
    async getStarsTopupOptions() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const result = await this.client.invoke(new Api.payments.GetStarsTopupOptions());
        return result.map((o) => ({
            stars: o.stars.toString(),
            currency: o.currency,
            amount: o.amount.toString(),
            extended: o.extended ?? false,
        }));
    }
    async getStarsSubscriptions(chatId, opts = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        const result = await this.client.invoke(new Api.payments.GetStarsSubscriptions({ peer, offset: opts.offset ?? "", missingBalance: opts.missingBalance }));
        const r = result;
        const subs = r.subscriptions ?? [];
        return {
            subscriptions: subs.map((s) => ({
                id: s.id,
                peerId: summarizePeer(s.peer).id,
                untilDate: s.untilDate,
                periodSeconds: s.pricing.period,
                priceStars: s.pricing.amount.toString(),
                canceled: s.canceled ?? false,
                title: s.title,
            })),
            nextOffset: r.subscriptionsNextOffset,
        };
    }
    async changeStarsSubscription(chatId, subscriptionId, canceled) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        await this.client.invoke(new Api.payments.ChangeStarsSubscription({ peer, subscriptionId, canceled }));
    }
    // ─── Quick replies ─────────────────────────────────────────────────────────
    async getQuickReplies(hash) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.messages.GetQuickReplies({ hash: hash ? bigInt(hash) : bigInt(0) }));
            if (!response)
                throw new Error("messages.GetQuickReplies returned nothing");
            return summarizeQuickReplies(response);
        }, "getQuickReplies");
    }
    async getQuickReplyMessages(shortcutId, options = {}) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const response = await this.client?.invoke(new Api.messages.GetQuickReplyMessages({
                shortcutId,
                id: options.ids,
                hash: options.hash ? bigInt(options.hash) : bigInt(0),
            }));
            if (!response)
                throw new Error("messages.GetQuickReplyMessages returned nothing");
            return summarizeQuickReplyMessages(response);
        }, `getQuickReplyMessages ${shortcutId}`);
    }
    // ─── Stories Write ─────────────────────────────────────────────────────────
    async sendStory(chatId, filePath, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const inputPeer = await client.getInputEntity(peer);
            const fileData = await readFile(filePath);
            const uploaded = await client.uploadFile({
                file: new CustomFile(filePath, fileData.length, filePath, fileData),
                workers: 4,
            });
            const mediaType = opts.type ?? detectMediaType(filePath);
            const media = mediaType === "photo"
                ? new Api.InputMediaUploadedPhoto({ file: uploaded })
                : new Api.InputMediaUploadedDocument({
                    file: uploaded,
                    mimeType: "video/mp4",
                    attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })],
                });
            const privacyRules = buildStoryPrivacyRules(opts.privacy, opts.allowUserIds, opts.disallowUserIds);
            let caption = opts.caption;
            let entities;
            if (opts.caption && opts.parseMode) {
                // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                const parser = client._parseMessageText;
                if (typeof parser === "function") {
                    [caption, entities] = await parser.call(client, opts.caption, opts.parseMode === "html" ? "html" : "md");
                }
            }
            const result = await client.invoke(new Api.stories.SendStory({
                peer: inputPeer,
                media,
                privacyRules,
                caption,
                ...(entities?.length ? { entities } : {}),
                randomId: generateRandomBigInt(),
                period: opts.period ?? 86400,
                pinned: opts.pinned,
                noforwards: opts.noforwards,
            }));
            const id = extractStoryIdFromUpdates(result) || undefined;
            return { id, period: opts.period ?? 86400 };
        }, `sendStory ${chatId}`);
    }
    async editStory(chatId, storyId, opts) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const client = this.client;
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const inputPeer = await client.getInputEntity(peer);
            const changed = [];
            let media;
            if (opts.filePath) {
                changed.push("media");
                const fileData = await readFile(opts.filePath);
                const uploaded = await client.uploadFile({
                    file: new CustomFile(opts.filePath, fileData.length, opts.filePath, fileData),
                    workers: 4,
                });
                const mediaType = opts.type ?? detectMediaType(opts.filePath);
                media =
                    mediaType === "photo"
                        ? new Api.InputMediaUploadedPhoto({ file: uploaded })
                        : new Api.InputMediaUploadedDocument({
                            file: uploaded,
                            mimeType: "video/mp4",
                            attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0, supportsStreaming: true })],
                        });
            }
            let caption = opts.caption;
            let entities;
            if (opts.caption !== undefined) {
                changed.push("caption");
                if (opts.caption && opts.parseMode) {
                    // biome-ignore lint/suspicious/noExplicitAny: GramJS internal helper, no public typing
                    const parser = client._parseMessageText;
                    if (typeof parser === "function") {
                        [caption, entities] = await parser.call(client, opts.caption, opts.parseMode === "html" ? "html" : "md");
                    }
                }
            }
            let privacyRules;
            if (opts.privacy) {
                changed.push("privacy");
                privacyRules = buildStoryPrivacyRules(opts.privacy, opts.allowUserIds, opts.disallowUserIds);
            }
            await client.invoke(new Api.stories.EditStory({
                peer: inputPeer,
                id: storyId,
                ...(media ? { media } : {}),
                ...(caption !== undefined ? { caption } : {}),
                ...(entities?.length ? { entities } : {}),
                ...(privacyRules ? { privacyRules } : {}),
            }));
            return { changed };
        }, `editStory ${chatId}/${storyId}`);
    }
    async deleteStories(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const deleted = await this.client?.invoke(new Api.stories.DeleteStories({ peer, id: ids }));
            return { deleted: deleted ?? [] };
        }, `deleteStories ${chatId}`);
    }
    async sendStoryReaction(chatId, storyId, emoji, addToRecent) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const reaction = emoji === "" ? new Api.ReactionEmpty() : new Api.ReactionEmoji({ emoticon: emoji });
            await this.client?.invoke(new Api.stories.SendReaction({ peer, storyId, reaction, addToRecent }));
        }, `sendStoryReaction ${chatId}/${storyId}`);
    }
    async exportStoryLink(chatId, storyId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.stories.ExportStoryLink({ peer, id: storyId }));
            if (!result)
                throw new Error("stories.ExportStoryLink returned nothing");
            return { link: result.link };
        }, `exportStoryLink ${chatId}/${storyId}`);
    }
    async readStories(chatId, maxId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const ids = await this.client?.invoke(new Api.stories.ReadStories({ peer, maxId }));
            return { ids: ids ?? [] };
        }, `readStories ${chatId}/${maxId}`);
    }
    async toggleStoryPinned(chatId, ids, pinned) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const affected = await this.client?.invoke(new Api.stories.TogglePinned({ peer, id: ids, pinned }));
            return { affected: affected ?? [] };
        }, `toggleStoryPinned ${chatId}`);
    }
    async toggleStoryPinnedToTop(chatId, ids) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.stories.TogglePinnedToTop({ peer, id: ids }));
            return { ok: true };
        }, `toggleStoryPinnedToTop ${chatId}`);
    }
    async activateStealthMode(past, future) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            await this.client?.invoke(new Api.stories.ActivateStealthMode({ past: past ?? false, future: future ?? false }));
        }, "activateStealthMode");
    }
    async getStoriesArchive(chatId, offsetId, limit) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.stories.GetStoriesArchive({ peer, offsetId, limit }));
            if (!result)
                throw new Error("stories.GetStoriesArchive returned nothing");
            return summarizeStoriesById(result);
        }, `getStoriesArchive ${chatId}`);
    }
    async reportStory(chatId, ids, option, message) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const optionBytes = Buffer.from(option, "base64");
            const result = await this.client?.invoke(new Api.stories.Report({ peer, id: ids, option: optionBytes, message }));
            if (!result)
                throw new Error("stories.Report returned nothing");
            return summarizeReportResult(result);
        }, `reportStory ${chatId}`);
    }
    // ─── Discussion & Read Receipts ────────────────────────────────────────────
    async getDiscussionMessage(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetDiscussionMessage({ peer, msgId: messageId }));
            if (!result)
                throw new Error("messages.GetDiscussionMessage returned nothing");
            return summarizeDiscussionMessage(result);
        }, `getDiscussionMessage ${chatId}/${messageId}`);
    }
    async getGroupsForDiscussion() {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.channels.GetGroupsForDiscussion());
            if (!result)
                throw new Error("channels.GetGroupsForDiscussion returned nothing");
            return summarizeGroupsForDiscussion(result);
        }, "getGroupsForDiscussion");
    }
    async getMessageReadParticipants(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            const result = await this.client?.invoke(new Api.messages.GetMessageReadParticipants({ peer, msgId: messageId }));
            if (!result)
                throw new Error("messages.GetMessageReadParticipants returned nothing");
            return summarizeReadParticipants(result, messageId);
        }, `getMessageReadParticipants ${chatId}/${messageId}`);
    }
    async getOutboxReadDate(chatId, messageId) {
        if (!this.client || !this.connected)
            throw new Error(NOT_CONNECTED_ERROR);
        const peer = await this.resolvePeer(chatId);
        return this.rateLimiter.execute(async () => {
            try {
                const result = await this.client?.invoke(new Api.messages.GetOutboxReadDate({ peer, msgId: messageId }));
                if (!result)
                    return { readAt: null };
                const date = result.date;
                return { readAt: new Date(date * 1000).toISOString() };
            }
            catch (e) {
                if (/NOT_READ_YET/i.test(e.message ?? ""))
                    return { readAt: null };
                throw e;
            }
        }, `getOutboxReadDate ${chatId}/${messageId}`);
    }
    async resolveInputGroupCall(chatId) {
        const entity = await this.resolveChat(chatId);
        let call;
        if (entity instanceof Api.Channel) {
            const full = await this.client?.invoke(new Api.channels.GetFullChannel({ channel: entity }));
            if (full?.fullChat instanceof Api.ChannelFull) {
                call = full.fullChat.call;
            }
        }
        else if (entity instanceof Api.Chat) {
            const full = await this.client?.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
            if (full?.fullChat instanceof Api.ChatFull) {
                call = full.fullChat.call;
            }
        }
        else {
            throw new Error("Group calls are only available for groups/supergroups/channels");
        }
        if (!call) {
            throw new Error(`No active group call in chat ${chatId}`);
        }
        return call;
    }
}
