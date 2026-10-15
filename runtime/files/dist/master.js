import { createServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GlobalLock } from "./global-lock.js";
import { encodeMessage, parseMessages, } from "./ipc-protocol.js";
import { releaseLock, releaseSocket, socketPath } from "./lock.js";
import { TelegramService } from "./telegram-client.js";
import { registerTools } from "./tools/index.js";
// Prefix diagnostics with the owner PID so concurrent client processes
// can be distinguished when investigating connection ownership.
const rawConsoleError = console.error.bind(console);
const PID_PREFIX = `[pid=${process.pid}]`;
console.error = (...args) => {
    if (typeof args[0] === "string")
        rawConsoleError(`${PID_PREFIX} ${args[0]}`, ...args.slice(1));
    else
        rawConsoleError(PID_PREFIX, ...args);
};
// Апстрим 1.41.5 (#71): потолок одного вызова в мастере — чуть меньше IPC-таймаута клиента:
// вызов на мёртвом MTProto не завершается никогда, и без потолка его сокет висит вечно.
// Telegram MCP Starter (A6/M7): IPC-таймаут у нас поднят (MCP_TELEGRAM_IPC_TIMEOUT_MS, на сервере
// час) ради долгих скачиваний — потолок считается от него же (апстрим зашил 28 с, что убило бы
// любую докачку дольше полуминуты), а прогресс M8 его продлевает, как продлевает таймер клиента.
function fisToolCallTimeoutMs() {
    const raw = Number(process.env.MCP_TELEGRAM_IPC_TIMEOUT_MS);
    const ipc = Number.isFinite(raw) && raw > 0 ? raw : 30_000;
    return Math.max(28_000, ipc - 2_000);
}
const TOOL_CALL_TIMEOUT_MS = fisToolCallTimeoutMs();
let cleanedUp = false;
function cleanup() {
    if (cleanedUp)
        return;
    cleanedUp = true;
    // Sync unlink only — process.exit handlers cannot await async server.close(),
    // and unlinking the socket file is sufficient to release the listening address.
    releaseLock();
    releaseSocket();
}
process.on("exit", cleanup);
// Serializes tool calls with QR login — login holds the lock for up to minutes.
// Telegram MCP Starter (A6): после сужения лока его берут ТОЛЬКО login/logout/QR (см. runExclusive),
// обычные инструменты через него не проходят вовсе.
const globalLock = new GlobalLock();
let activeLogin = null;
// Telegram MCP Starter (A6). Раньше ОДИН глобальный лок держали все инструменты подряд, поэтому
// 10-минутная докачка видео замораживала живой чат ассистента на всё это время. Теперь
// эксклюзивно (под globalLock) выполняются только смены состояния сессии — логин и логаут;
// read-only и download-инструменты идут параллельно, лишь дожидаясь конца логина.
const EXCLUSIVE_TOOLS = new Set(["telegram-login", "telegram-logout"]);
let exclusiveGate = null;
async function runExclusive(fn) {
    const unlock = await globalLock.acquire();
    let release = () => { };
    exclusiveGate = new Promise((resolve) => {
        release = resolve;
    });
    try {
        return await fn();
    }
    finally {
        exclusiveGate = null;
        release();
        unlock();
    }
}
/** Обычные инструменты не блокируют друг друга, но не стартуют посреди логина/логаута. */
// Telegram MCP Starter (A11): ожидание эксклюзива — с потолком TELEGRAM_EXCLUSIVE_WAIT_MS (120 с):
// зависший логаут не держит все остальные вызовы бесконечно.
function fisEnvMs(name, dflt) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
}
async function waitForExclusive() {
    const deadline = Date.now() + fisEnvMs("TELEGRAM_EXCLUSIVE_WAIT_MS", 120_000);
    while (exclusiveGate) {
        const left = deadline - Date.now();
        if (left <= 0)
            throw new Error("Telegram занят входом/выходом дольше потолка — повторите позже");
        let timer;
        await Promise.race([exclusiveGate, new Promise((r) => { timer = setTimeout(r, left); timer.unref?.(); })]);
        clearTimeout(timer);
    }
}
// Telegram MCP Starter (A2). srv.listen() поднимался ДО завершения loadSession/connect, поэтому
// первый же tool-вызов попадал в середину коннекта и порождал второго клиента на том же
// auth_key. Гейт заставляет клиента подождать готовности, а не получить отказ.
let readyGate = null;
export function setReadyGate(promise) {
    readyGate = promise;
}
/**
 * Resolve to the handler's result, or reject once `ms` elapses.
 *
 * The underlying promise is left running — it cannot be cancelled — but it no longer holds
 * globalLock or the client's response, so the daemon keeps serving. The timer is unref'd so
 * a pending timeout never keeps the process alive on shutdown.
 */
function withTimeout(promise, ms, label, hooks) {
    return new Promise((resolve, reject) => {
        let timer;
        // Telegram MCP Starter (M8): hooks.rearm перезаводит потолок на каждом прогрессе.
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => reject(new Error(`Tool call timed out after ${ms}ms: ${label}`)), ms);
            timer.unref?.();
        };
        arm();
        if (hooks)
            hooks.rearm = arm;
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
export function handleClient(socket, mcpServer, telegram, opts = {}) {
    const toolCallTimeoutMs = opts.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;
    let buf = "";
    let processing = false;
    const queue = [];
    // Per-socket FIFO: messages from one client execute in arrival order.
    // Telegram MCP Starter (A6): разные сокеты теперь работают ПАРАЛЛЕЛЬНО — общий лок держат
    // только login/logout/QR. Внутри одного сокета порядок по-прежнему строгий, поэтому
    // долгая докачка задерживает следующие вызовы того же клиента (но не других).
    async function drainQueue() {
        if (processing)
            return;
        processing = true;
        // Telegram MCP Starter (A2): ни один запрос не выполняется, пока не завершился
        // стартовый loadSession/connect владельца сессии.
        if (readyGate) {
            try {
                await readyGate;
            }
            catch { }
        }
        while (queue.length > 0) {
            // Telegram MCP Starter (A11): клиент ушёл — его очередь не исполняем (он о результате
            // уже не узнает, а send-message ушёл бы без свидетеля и повторился бы).
            if (socket.destroyed) {
                queue.length = 0;
                break;
            }
            const msg = queue.shift();
            if (!msg)
                break;
            if (msg.type === "tool") {
                await handleToolRequest(socket, msg, mcpServer, telegram, toolCallTimeoutMs);
            }
            else if (msg.type === "login_start") {
                await handleLoginStart(socket, msg, telegram);
            }
            // Responses and QR frames are master→client only — client-side messages ignored here
        }
        processing = false;
    }
    socket.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const { messages, remaining } = parseMessages(buf);
        buf = remaining;
        for (const msg of messages) {
            // Telegram MCP Starter (A11): отмена по id. Вызов, ещё стоящий в очереди сокета, клиент
            // снимает, когда сам перестал его ждать (свой таймаут, отмена MCP). Иначе он
            // исполнился бы позже — а клиент уже доложил ошибку, и повтор send-message
            // дал бы второе сообщение. Начатый вызов отменить нельзя — только не начинать.
            if (msg.type === "tool_cancel") {
                const i = queue.findIndex((m) => m.type === "tool" && m.id === msg.id);
                if (i >= 0) {
                    queue.splice(i, 1);
                    send(socket, { type: "tool_response", id: msg.id, error: "Вызов отменён клиентом до начала исполнения" });
                }
                continue;
            }
            queue.push(msg);
        }
        drainQueue();
    });
    // If this socket owned an in-progress QR login, abort it so globalLock
    // releases and tool calls from other clients aren't blocked for minutes.
    socket.on("close", () => {
        if (activeLogin && activeLogin.socket === socket) {
            activeLogin.abort.abort();
        }
    });
    // Node requires an error listener on sockets. EPIPE/ECONNRESET happen when the peer
    // disappears mid-write; log for diagnostics but don't crash the master.
    socket.on("error", (err) => {
        console.error("[mcp-telegram] IPC socket error:", err.message);
    });
}
function send(socket, msg) {
    if (!socket.destroyed)
        socket.write(encodeMessage(msg));
}
async function handleToolRequest(socket, req, mcpServer, telegram, timeoutMs = TOOL_CALL_TIMEOUT_MS) {
    const tool = mcpServer._registeredTools[req.tool];
    const response = { type: "tool_response", id: req.id };
    if (!tool) {
        response.error = `Unknown tool: ${req.tool}`;
    }
    else {
        // telegram-logout must cancel an in-progress QR login instead of queueing behind it
        // for up to 5 minutes. Aborting releases the globalLock held by handleLoginStart.
        if (req.tool === "telegram-logout" && activeLogin) {
            activeLogin.abort.abort();
        }
        try {
            // Telegram MCP Starter (M8): канал прогресса до клиента. Долгие операции (скачивание
            // больших файлов) иначе молчат, и MCP-клиент рвёт запрос по СВОЕМУ таймауту —
            // у SDK это 60 с, к нашему IPC-таймауту он отношения не имеет.
            const fisTimer = {};
            const fisExtra = {
                sendProgress: (progress, total) => {
                    fisTimer.rearm?.();
                    send(socket, { type: "tool_progress", id: req.id, progress, total });
                },
            };
            // Telegram MCP Starter (A6): эксклюзив — только для логина/логаута; остальное параллельно.
            if (EXCLUSIVE_TOOLS.has(req.tool)) {
                // Telegram MCP Starter (A11): логаут — потолок TELEGRAM_LOGOUT_MS (120 с); вход по коду —
                // TELEGRAM_LOGIN_MS (360 с, окно QR ~5 мин). Без потолка зависший логаут держал
                // globalLock, а с ним — все вызовы всех клиентов.
                const ceiling = req.tool === "telegram-logout"
                    ? fisEnvMs("TELEGRAM_LOGOUT_MS", 120_000)
                    : fisEnvMs("TELEGRAM_LOGIN_MS", 360_000);
                response.result = await runExclusive(() => withTimeout(tool.handler(req.args ?? {}, fisExtra), ceiling, req.tool));
            }
            else {
                await waitForExclusive();
                response.result = await withTimeout(tool.handler(req.args ?? {}, fisExtra), timeoutMs, req.tool, fisTimer);
            }
        }
        catch (err) {
            response.error = err instanceof Error ? err.message : String(err);
            // A call that burns the whole budget is the signature of a dead MTProto transport that
            // our cached `connected` flag still reports as live. Flag it so the NEXT call
            // revalidates and reconnects, instead of every subsequent call hanging the same way.
            if (err instanceof Error && err.message.startsWith("Tool call timed out")) {
                console.error(`[mcp-telegram] ${err.message} — marking Telegram connection unhealthy`);
                telegram.markUnhealthy(`tool call timed out: ${req.tool}`);
            }
        }
    }
    send(socket, response);
}
async function handleLoginStart(socket, req, telegram) {
    const fail = (error) => send(socket, { type: "login_done", id: req.id, success: false, error });
    if (activeLogin) {
        fail("Another QR login is already in progress");
        return;
    }
    const abort = new AbortController();
    activeLogin = { socket, abort };
    try {
        // Telegram MCP Starter (A6): QR-логин пересобирает соединение — это единственный класс
        // операций, которому по-прежнему нужен эксклюзивный лок на весь процесс.
        await runExclusive(async () => {
            const result = await telegram.startQrLogin(() => { }, (url) => send(socket, { type: "login_qr", id: req.id, url }), abort.signal);
            if (result.success) {
                const me = await telegram.getMe();
                send(socket, { type: "login_done", id: req.id, success: true, username: me.username ?? undefined });
            }
            else {
                fail(result.message);
            }
        });
    }
    catch (err) {
        fail(err instanceof Error ? err.message : String(err));
    }
    finally {
        activeLogin = null;
    }
}
/**
 * Bootstrap the connection owner shared by master (stdio) and serve (daemon) modes:
 * build the tool registry, listen on the IPC socket, install a graceful shutdown that
 * disconnects Telegram, and auto-connect the single client. No stdio is attached here —
 * the caller decides whether to also serve a stdio MCP session (master) or not (serve).
 */
export async function startOwner(telegram, version, opts = {}) {
    const label = opts.label ?? "mcp-telegram";
    const server = new McpServer({ name: "mcp-telegram", version });
    registerTools(server, telegram);
    const mcpServer = server;
    // Remove a stale socket file from a previous crash before attempting to listen.
    releaseSocket();
    // Telegram MCP Starter (A2): гейт готовности ставим ДО listen(). Авто-коннект переехал сюда
    // из хвоста функции — раньше он стартовал уже после того, как сокет начинал принимать
    // клиентов, и первый tool-вызов приходил в момент незавершённого connect().
    setReadyGate((async () => {
        try {
            await telegram.loadSession();
            if (await telegram.connect()) {
                const me = await telegram.getMe();
                console.error(`[${label}] connected as @${me.username}`);
            }
            else if (telegram.lastError) {
                console.error(`[${label}] ${telegram.lastError}`);
            }
        }
        catch (err) {
            console.error(`[${label}] Auto-connect failed:`, err);
        }
    })());
    const sock = socketPath();
    const srv = createServer((socket) => {
        console.error(`[${label}] client connected`);
        socket.on("close", () => console.error(`[${label}] client disconnected`));
        handleClient(socket, mcpServer, telegram);
    });
    await new Promise((resolve, reject) => {
        srv.listen(sock, resolve);
        srv.once("error", reject);
    });
    const { chmod } = await import("node:fs/promises");
    try {
        await chmod(sock, 0o600);
    }
    catch {
        // Best-effort hardening of the IPC endpoint. Expected to fail on win32, where `sock` is
        // a named pipe rather than a file (see socketPath()); the pipe's default DACL already
        // restricts it to the creating user's session. Also fails on filesystems without POSIX
        // modes. Neither case is worth refusing to serve over.
    }
    console.error(`[${label}] IPC socket ready: ${sock}`);
    let shuttingDown = false;
    // Record shutdown reasons to distinguish intentional stops from failures.
    const gracefulExit = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        const cause = signal ? `signal ${signal}` : "stdio closed / programmatic";
        console.error(`[${label}] Shutting down (${cause}), disconnecting from Telegram...`);
        try {
            await telegram.disconnect();
        }
        catch (err) {
            console.error(`[${label}] Disconnect error:`, err);
        }
        process.exit(0);
    };
    // Node передаёт имя сигнала первым аргументом — оно попадает в лог (Telegram MCP Starter C6).
    process.on("SIGINT", gracefulExit);
    process.on("SIGTERM", gracefulExit);
    // Авто-коннект больше НЕ висит здесь: он стартует до listen() и живёт в readyGate
    // (Telegram MCP Starter A2, см. выше).
    return { server, srv, gracefulExit };
}
export async function runMaster(apiId, apiHash, version) {
    const telegram = new TelegramService(apiId, apiHash);
    const { server, gracefulExit } = await startOwner(telegram, version, { label: "mcp-telegram (master)" });
    // Parent (Claude Code / MCP client) can close stdio without sending a signal.
    // Without this, the process keeps running as an orphan with a live Telegram connection,
    // blocking auth_key from being reused — causes AUTH_KEY_DUPLICATED on next start.
    process.stdin.on("end", gracefulExit);
    // Master also serves the launching window directly over stdio.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp-telegram] MCP server running on stdio (master)");
}
