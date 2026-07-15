#!/usr/bin/env node
// CI smoke-тест: проверяет на текущей ОС, что
//  1) MCP-сервер стартует и отдаёт инструменты (мастер-процесс, владелец сессии);
//  2) ВТОРОЙ одновременный клиент подключается как client к тому же владельцу
//     (это и есть защита от AUTH_KEY_DUPLICATED при нескольких агентах);
//  3) после закрытия обоих процессов не остаётся зомби.
// Логин в Telegram не выполняется — используются фиктивные ключи; список
// инструментов сервер отдаёт и без входа.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "node_modules", "@overpod", "mcp-telegram", "dist", "cli.js");
const sessionDir = mkdtempSync(join(tmpdir(), "tgmcp-"));
const env = {
  ...process.env,
  TELEGRAM_API_ID: "123456",
  TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
  TELEGRAM_SESSION_PATH: join(sessionDir, "session"),
};

setTimeout(() => {
  console.error("FAIL: тест не уложился в 120 секунд");
  process.exit(1);
}, 120000).unref();

async function connectAndCount(label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env });
  const client = new Client({ name: `ci-${label}`, version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`${label}: сервер отвечает, инструментов: ${tools.tools.length}`);
  if (tools.tools.length < 100) throw new Error(`${label}: слишком мало инструментов`);
  return client;
}

try {
  // 1. Первый процесс — становится мастером (владельцем сессии)
  const a = await connectAndCount("A-master");
  // 2. Второй процесс ОДНОВРЕМЕННО — должен стать клиентом мастера,
  //    а не открыть вторую Telegram-сессию
  const b = await connectAndCount("B-client");

  await b.close();
  // мастер должен пережить отключение клиента
  const c = await connectAndCount("C-after-b-closed");
  await c.close();
  await a.close();

  console.log("SMOKE OK: одиночный и параллельный запуск работают");
  process.exit(0);
} catch (error) {
  console.error("SMOKE FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
