#!/usr/bin/env node
// Проверяет установленный runtime, затем выполняет MCP initialize + tools/list без вызова инструментов.
// Явный флаг --status дополнительно вызывает telegram-status и требует авторизованную сессию.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const statusMode = argv[0] === "--status";
if (statusMode) argv.shift();
const [command, ...args] = argv;
if (!command) {
  console.error("Использование: node doctor.mjs [--status] <команда-сервера> [аргументы...]");
  process.exit(2);
}

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(serverRoot, "runtime", "manifest.json");
const receiptPath = join(serverRoot, "runtime", "source-receipt.json");
const packageDir = join(serverRoot, "node_modules", "@overpod", "mcp-telegram");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (receipt.repository !== "alexfisenkov/telegram-mcp-starter" || receipt.version !== "v2.0.0" ||
      !/^[a-f0-9]{40}$/.test(receipt.commitSHA ?? "")) {
    throw new Error("source receipt is missing or does not contain the pinned public commit SHA");
  }
  if (manifest.schema !== "telegram-mcp-starter-runtime-v1" || manifest.packageName !== "@overpod/mcp-telegram") {
    throw new Error("неподдерживаемая схема runtime manifest");
  }
  if (pkg.version !== manifest.packageVersion || pkg.version !== "1.43.1") {
    throw new Error(`ожидалась версия ${manifest.packageVersion}, установлена ${pkg.version}`);
  }
  const telegramDependency = JSON.parse(readFileSync(join(packageDir, "node_modules", "telegram", "package.json"), "utf8"));
  if (telegramDependency.name !== manifest.telegramDependency?.packageName ||
      telegramDependency.version !== manifest.telegramDependency?.version ||
      manifest.telegramDependency?.alias !== "telegram") {
    throw new Error("установленная telegram dependency не совпадает с закреплённым teleproto alias");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 17) {
    throw new Error("manifest должен перечислять 17 runtime-файлов");
  }
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split(/[\\/]/).includes("..")) {
      throw new Error("manifest содержит небезопасный путь runtime-файла");
    }
    if (!/^[a-f0-9]{64}$/.test(entry.postimageSha256 ?? "")) {
      throw new Error(`manifest содержит некорректный хэш: ${entry.path}`);
    }
    const actual = createHash("sha256").update(readFileSync(join(packageDir, entry.path))).digest("hex");
    if (actual !== entry.postimageSha256) throw new Error(`хэш runtime-файла не совпадает: ${entry.path} (expected ${entry.postimageSha256}, found ${actual})`);
  }
  console.log(`[OK] Runtime manifest подтверждён: ${pkg.version}, ${manifest.files.length} файлов.`);
  console.log(`[OK] Source receipt: ${receipt.repository} ${receipt.version} ${receipt.commitSHA}.`);
} catch (error) {
  console.error(`[X] Проверка runtime не прошла: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const probeDir = statusMode ? null : mkdtempSync(join(tmpdir(), "telegram-mcp-doctor-"));
const env = {};
const safeEnvironmentNames = new Set([
  "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC",
]);
for (const [key, value] of Object.entries(process.env)) {
  if (safeEnvironmentNames.has(key.toUpperCase())) env[key] = value;
}
if (!statusMode) {
  env.TELEGRAM_API_ID = "1";
  env.TELEGRAM_API_HASH = "invalid-fixture";
  env.TELEGRAM_MCP_NO_AUTH = "1";
  env.TELEGRAM_SESSION_PATH = join(probeDir, "session-does-not-exist");
  env.TELEGRAM_PROXY_IP = "127.0.0.1";
  env.TELEGRAM_PROXY_PORT = "9";
  env.TELEGRAM_PROXY_SOCKS_TYPE = "5";
}
const transport = new StdioClientTransport({ command, args, env });
const client = new Client({ name: "telegram-mcp-doctor", version: "2.0.0" });
const timer = setTimeout(() => {
  console.error("[X] MCP-сервер не ответил за 30 секунд.");
  process.exit(1);
}, 30000);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const minimumTools = 180;
  const maximumTools = statusMode ? 193 : 180;
  if (tools.tools.length < minimumTools || tools.tools.length > maximumTools) {
    throw new Error(`Ожидалось ${statusMode ? "180–193" : "180"} инструментов для закреплённого runtime; получено ${tools.tools.length}. Перезапустите старую службу или MCP-клиенты и повторите проверку.`);
  }
  console.log(`[OK] MCP initialize + tools/list прошли без вызова инструментов: ${tools.tools.length} доступно.`);
  if (statusMode) {
    const status = await client.callTool({ name: "telegram-status", arguments: {} });
    const text = (status.content ?? []).map((item) => item.text ?? "").join("\n").trim();
    const connected = !status.isError && /^Connected\b/i.test(text) && !/not\s+(logged|connected|authorized)/i.test(text);
    if (connected) {
      console.log("[OK] telegram-status подтвердил авторизованное подключение.");
    } else {
      console.error("[X] telegram-status не подтвердил авторизованное подключение.");
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`[X] Ошибка MCP-проверки: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
}
