#!/usr/bin/env node
// Патч для @overpod/mcp-telegram@1.41.2 (закреплённая версия).
//
// Проблема: на Windows пакет пытается слушать unix-сокет по файловому пути
// (C:\...\daemon.sock). Node.js на Windows такое не умеет — сервер падает при
// старте с "listen EACCES" (проверено в CI на windows-latest). Из-за этого без
// патча Telegram MCP на Windows не работает вовсе.
//
// Решение: на Windows слушаем именованный канал \\.\pipe\mcp-telegram-<папка
// сессии> — стандартный механизм IPC Windows. Имя канала уникально для каждой
// папки сессии, поэтому несколько аккаунтов не конфликтуют. Поведение на
// macOS/Linux не меняется. Патч идемпотентен и проверяет, что код пакета
// именно тот, который ожидается (закреплённая версия).
//
// Установщик install.ps1 применяет этот патч автоматически.
// Использование: node patch-win32-socket.mjs <путь к dist/lock.js>
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("Использование: node patch-win32-socket.mjs <путь к dist/lock.js>");
  process.exit(2);
}

const MARKER = "telegram-mcp-starter win32 pipe patch";
const src = readFileSync(target, "utf8");
if (src.includes(MARKER)) {
  console.log("Патч уже применён — пропускаю.");
  process.exit(0);
}

const needle = `export function socketPath() {
    return join(resolveSessionDir(), "daemon.sock");
}`;

if (!src.includes(needle)) {
  console.error("✗ Не нашёл ожидаемый код socketPath() — версия пакета отличается от закреплённой? Патч НЕ применён.");
  process.exit(1);
}

const replacement = `export function socketPath() {
    // ${MARKER}: Node на Windows не умеет слушать unix-сокет по файловому
    // пути (listen EACCES) — используем именованный канал, уникальный для папки сессии.
    if (process.platform === "win32") {
        return "\\\\\\\\.\\\\pipe\\\\mcp-telegram-" + resolveSessionDir().replace(/[\\\\/:]/g, "-");
    }
    return join(resolveSessionDir(), "daemon.sock");
}`;

writeFileSync(target, src.replace(needle, replacement));
console.log("✓ Патч применён: " + target);
