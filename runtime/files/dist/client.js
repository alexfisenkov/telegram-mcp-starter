import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encodeMessage, parseMessages, } from "./ipc-protocol.js";
import { socketPath } from "./lock.js";
import { TelegramService } from "./telegram-client.js";
import { registerTools } from "./tools/index.js";
const CONNECT_TIMEOUT_MS = 5_000;
const IPC_CALL_TIMEOUT_MS = 30_000;
/**
 * Telegram MCP Starter (A6). Жёсткие 30 с были зашиты намертво: runClient создавал IpcClient
 * без опций, переопределить таймаут было нечем. Из-за этого долгая (но нормальная)
 * операция выглядела как «демон завис», внешний скрипт убивал демона, launchd поднимал
 * новый — и следующий tool-вызов попадал в незавершённый connect. Так рождался
 * AUTH_KEY_DUPLICATED.
 * Теперь таймаут задаётся через MCP_TELEGRAM_IPC_TIMEOUT_MS (мс).
 * ВАЖНО: увеличивать его безопасно только вместе с сужением глобального лока в master.js —
 * иначе одна долгая докачка заморозит остальных клиентов на всё это время.
 */
function resolveIpcCallTimeout() {
    const raw = Number(process.env.MCP_TELEGRAM_IPC_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : IPC_CALL_TIMEOUT_MS;
}
const LOGIN_FLOW_TIMEOUT_MS = 360_000; // 6 min — QR has ~5 min server-side window
const MAX_RECONNECT_ATTEMPTS = 5;
/** Thin IPC proxy: forwards tool calls to the master process over Unix socket */
export class IpcClient {
    socket = null;
    pending = new Map();
    pendingLogins = new Map();
    buf = "";
    connected = false;
    destroyed = false;
    onDisconnect;
    connectTimeoutMs;
    callTimeoutMs;
    loginTimeoutMs;
    connectFn;
    constructor(opts = {}) {
        this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
        // Telegram MCP Starter (A6): дефолт берём из env, а не из константы — чинит runClient,
        // который создаёт IpcClient вообще без опций.
        this.callTimeoutMs = opts.callTimeoutMs ?? resolveIpcCallTimeout();
        this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_FLOW_TIMEOUT_MS;
        this.connectFn = opts.connectFn ?? connect;
    }
    /** Register a callback fired when the peer socket closes unexpectedly.
     * Call this AFTER a successful connect() so aborted connection attempts don't fire it. */
    setOnDisconnect(cb) {
        this.onDisconnect = cb;
    }
    async connect() {
        return new Promise((resolve) => {
            const sock = socketPath();
            const s = this.connectFn(sock);
            // One-shot connect timeout — cleared immediately on connect (HIGH-3)
            const connectTimer = setTimeout(() => {
                s.destroy();
                resolve(false);
            }, this.connectTimeoutMs);
            const onConnect = () => {
                clearTimeout(connectTimer);
                this.socket = s;
                this.connected = true;
                s.removeListener("error", onError);
                s.on("data", (chunk) => {
                    this.buf += chunk.toString("utf-8");
                    const { messages, remaining } = parseMessages(this.buf);
                    this.buf = remaining;
                    for (const msg of messages)
                        this.routeMessage(msg);
                });
                s.on("close", () => {
                    this.connected = false;
                    for (const [, p] of this.pending) {
                        clearTimeout(p.timer);
                        p.reject(new Error("IPC connection closed"));
                    }
                    this.pending.clear();
                    for (const [, l] of this.pendingLogins) {
                        clearTimeout(l.timer);
                        l.reject(new Error("IPC connection closed"));
                    }
                    this.pendingLogins.clear();
                    if (!this.destroyed)
                        this.onDisconnect?.();
                });
                // Post-connect errors (EPIPE, ECONNRESET) land here. Silent drop keeps the
                // process alive for the "close" handler above to clean up pending calls.
                // Node requires an error listener on sockets — absence crashes the process.
                s.on("error", () => { });
                resolve(true);
            };
            const onError = () => {
                clearTimeout(connectTimer);
                resolve(false);
            };
            s.once("connect", onConnect);
            s.once("error", onError);
        });
    }
    routeMessage(msg) {
        if (msg.type === "tool_response") {
            const pending = this.pending.get(msg.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error)
                pending.reject(new Error(msg.error));
            else
                pending.resolve(msg.result);
            return;
        }
        // Telegram MCP Starter (M8): прогресс — признак жизни. Продлеваем СВОЙ таймаут и
        // пробрасываем событие наверх, чтобы MCP-клиент тоже не считал вызов зависшим.
        if (msg.type === "tool_progress") {
            const pending = this.pending.get(msg.id);
            if (!pending)
                return;
            pending.rearm?.();
            pending.onProgress?.(msg.progress, msg.total);
            return;
        }
        if (msg.type === "login_qr") {
            const login = this.pendingLogins.get(msg.id);
            login?.onQr(msg.url);
            return;
        }
        if (msg.type === "login_done") {
            const login = this.pendingLogins.get(msg.id);
            if (!login)
                return;
            clearTimeout(login.timer);
            this.pendingLogins.delete(msg.id);
            login.resolve(msg);
            return;
        }
        // tool / login_start are client→master only; ignored if received
    }
    isConnected() {
        return this.connected;
    }
    async call(tool, args, onProgress, signal) {
        if (!this.socket || !this.connected) {
            throw new Error("IPC client not connected");
        }
        const id = randomUUID();
        const socket = this.socket;
        // Telegram MCP Starter (A11): перестали ждать — просим мастер не начинать вызов.
        const cancel = () => {
            try {
                if (!socket.destroyed)
                    socket.write(encodeMessage({ type: "tool_cancel", id }));
            }
            catch { }
        };
        return new Promise((resolve, reject) => {
            // Telegram MCP Starter (M8): таймер перезаводится на каждом прогрессе, иначе
            // многочасовая докачка упрётся в таймаут, хотя идёт полным ходом.
            const entry = { resolve, reject, timer: null, onProgress };
            const arm = () => {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    cancel();
                    reject(new Error(`IPC call timeout: ${tool}`));
                }, this.callTimeoutMs);
            };
            entry.rearm = () => { clearTimeout(entry.timer); arm(); };
            arm();
            if (signal) {
                const onAbort = () => {
                    if (!this.pending.has(id))
                        return;
                    clearTimeout(entry.timer);
                    this.pending.delete(id);
                    cancel();
                    reject(new Error(`Отменено клиентом MCP: ${tool}`));
                };
                if (signal.aborted) {
                    clearTimeout(entry.timer);
                    reject(new Error(`Отменено клиентом MCP: ${tool}`));
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
            this.pending.set(id, entry);
            socket.write(encodeMessage({ type: "tool", id, tool, args }));
        });
    }
    /** Request QR login flow from master. `onQr` fires for each QR URL frame (refreshes ~every 10s).
     * Only one login can run on the master side at a time — a concurrent call gets an immediate
     * `login_done {success:false}` with "Another QR login is already in progress". */
    async loginFlow(onQr) {
        if (!this.socket || !this.connected) {
            throw new Error("IPC client not connected");
        }
        const id = randomUUID();
        const socket = this.socket;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingLogins.delete(id);
                reject(new Error("Login flow timeout"));
            }, this.loginTimeoutMs);
            this.pendingLogins.set(id, { onQr, resolve, reject, timer });
            socket.write(encodeMessage({ type: "login_start", id }));
        });
    }
    destroy() {
        this.destroyed = true;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("IPC client destroyed"));
        }
        this.pending.clear();
        for (const [, l] of this.pendingLogins) {
            clearTimeout(l.timer);
            l.reject(new Error("IPC client destroyed"));
        }
        this.pendingLogins.clear();
        this.socket?.destroy();
        this.socket = null;
        this.connected = false;
    }
}
function wireIpcProxies(server, ipc) {
    const s = server;
    for (const [name, tool] of Object.entries(s._registeredTools)) {
        Object.assign(tool, {
            // Telegram MCP Starter (M8): прогресс уходит клиенту как notifications/progress —
            // по спецификации MCP это сбрасывает его таймаут ожидания ответа.
            handler: (args, extra) => ipc.call(name, args, (progress, total) => {
                const token = extra?._meta?.progressToken;
                if (token === undefined || typeof extra?.sendNotification !== "function")
                    return;
                Promise.resolve(extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken: token, progress, ...(total != null ? { total } : {}) },
                })).catch(() => { });
            }, extra?.signal),  // Telegram MCP Starter (A11): отмена MCP → tool_cancel мастеру
        });
    }
}
export async function runClient(apiId, apiHash, version) {
    // Try to connect to master with retries — master may still be initializing its socket
    let ipc = null;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
        // Telegram MCP Starter (A6): таймаут вызова берётся из MCP_TELEGRAM_IPC_TIMEOUT_MS
        // (см. resolveIpcCallTimeout выше), передаём явно, чтобы значение было видно в коде.
        const candidate = new IpcClient({ callTimeoutMs: resolveIpcCallTimeout() });
        if (await candidate.connect()) {
            ipc = candidate;
            break;
        }
        if (attempt < MAX_RECONNECT_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, 150 * 2 ** attempt)); // 150ms, 300ms, 600ms, 1200ms
        }
    }
    if (!ipc) {
        // Master acquired lock but socket not ready — this process should not become master
        // (it lost the lock race). Exit with clear message instead of creating two masters (CRITICAL-2)
        console.error("[mcp-telegram] Cannot connect to master process. Try again in a moment.");
        process.exit(1);
    }
    console.error(`[mcp-telegram] Client mode — proxying to master via ${socketPath()}`);
    // Master died → socket closes → nothing to proxy. Exit so parent respawns us against a fresh master.
    // Wire only AFTER successful connect, so retry attempts inside the loop above can't trip it.
    ipc.setOnDisconnect(() => {
        console.error("[mcp-telegram] IPC connection to master closed, exiting");
        process.exit(1);
    });
    // Register all tools for MCP schema; dummy telegram instance is never used for actual calls
    const telegram = new TelegramService(apiId, apiHash);
    const server = new McpServer({ name: "mcp-telegram", version });
    registerTools(server, telegram);
    // Replace all handlers with IPC-forwarding versions
    wireIpcProxies(server, ipc);
    // Parent closed stdio → exit so parent can spawn a fresh instance cleanly
    process.stdin.on("end", () => process.exit(0));
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp-telegram] MCP server running on stdio (client)");
}
