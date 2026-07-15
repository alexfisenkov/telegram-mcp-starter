#!/usr/bin/env node
// Безопасно добавляет (или удаляет) сервер "telegram" в JSON-конфиг MCP-клиента
// (например, claude_desktop_config.json). Перед изменением делает резервную копию.
//
// Это каноническая копия скрипта — установщики кладут такой же файл
// в ~/.telegram-mcp/server/merge-config.mjs.
//
// Использование:
//   node merge-config.mjs <config.json> <command> [args...]   — добавить/обновить
//   node merge-config.mjs <config.json> --remove              — удалить
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const [configPath, command, ...args] = process.argv.slice(2);
if (!configPath || !command) {
  console.error("Использование: node merge-config.mjs <config.json> <command|--remove> [args...]");
  process.exit(2);
}

let config = {};
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(configPath, `${configPath}.backup-${stamp}`);
  if (raw.trim() !== "") {
    try {
      config = JSON.parse(raw);
    } catch {
      console.error(`✗ Файл повреждён (невалидный JSON): ${configPath}. Исправьте его вручную.`);
      process.exit(1);
    }
  }
} else {
  mkdirSync(dirname(configPath), { recursive: true });
}

config.mcpServers = config.mcpServers ?? {};
if (command === "--remove") {
  delete config.mcpServers.telegram;
  console.log(`✓ Сервер "telegram" удалён из ${configPath}`);
} else {
  config.mcpServers.telegram = args.length > 0 ? { command, args } : { command };
  console.log(`✓ Сервер "telegram" добавлен в ${configPath}`);
}
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
