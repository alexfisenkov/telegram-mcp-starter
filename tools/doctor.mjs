#!/usr/bin/env node
// Доктор: подключается к Telegram MCP как настоящий MCP-клиент и вызывает telegram-status.
//
// Это каноническая копия скрипта — установщики (install.sh / install.ps1) кладут
// такой же файл в ~/.telegram-mcp/server/doctor.mjs, чтобы он находил зависимости
// в node_modules установленного сервера.
//
// Использование:
//   macOS/Linux:  node ~/.telegram-mcp/server/doctor.mjs ~/.telegram-mcp/run.sh
//   Windows:      node %USERPROFILE%\.telegram-mcp\server\doctor.mjs cmd /c %USERPROFILE%\.telegram-mcp\run.cmd
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Использование: node doctor.mjs <команда-сервера> [аргументы...]");
  process.exit(2);
}

const transport = new StdioClientTransport({ command, args, env: { ...process.env } });
const client = new Client({ name: "telegram-mcp-doctor", version: "1.0.0" });
const timer = setTimeout(() => {
  console.error("✗ Сервер не ответил за 90 секунд. Проверьте интернет и docs/TROUBLESHOOTING.md");
  process.exit(1);
}, 90000);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`✓ MCP-сервер запустился, инструментов доступно: ${tools.tools.length}`);
  const status = await client.callTool({ name: "telegram-status", arguments: {} });
  const text = (status.content ?? []).map((i) => i.text ?? "").join("\n").trim();
  console.log(text);
  if (status.isError) {
    console.error("! Инструмент telegram-status вернул ошибку — см. текст выше.");
    process.exitCode = 1;
  }
  if (/not\s+(logged|connected|authorized)/i.test(text)) {
    console.error("! Похоже, вы ещё не вошли в аккаунт — выполните вход по QR-коду (login).");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`✗ Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}
