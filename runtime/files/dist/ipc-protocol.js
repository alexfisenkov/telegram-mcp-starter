/** Encode a message as newline-delimited JSON */
export function encodeMessage(msg) {
    return `${JSON.stringify(msg)}\n`;
}
/** Parse newline-delimited JSON messages from a buffer, returns parsed messages + leftover */
export function parseMessages(buf) {
    const lines = buf.split("\n");
    const remaining = lines.pop() ?? "";
    const messages = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (isIpcMessage(parsed))
                messages.push(parsed);
        }
        catch {
            // Skip malformed lines
        }
    }
    return { messages, remaining };
}
function isIpcMessage(m) {
    if (!m || typeof m !== "object" || typeof m.type !== "string" || typeof m.id !== "string")
        return false;
    return (m.type === "tool" ||
        m.type === "tool_response" ||
        // Telegram MCP Starter (M8): промежуточный прогресс долгих операций
        m.type === "tool_progress" ||
        // Telegram MCP Starter (A11): отмена вызова, ещё стоящего в очереди мастера
        m.type === "tool_cancel" ||
        m.type === "login_start" ||
        m.type === "login_qr" ||
        m.type === "login_done");
}
