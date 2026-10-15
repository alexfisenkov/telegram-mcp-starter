#!/usr/bin/env node
// Static regression gate for public installer safety and the pinned runtime contract.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sh = read("install.sh");
const ps = read("install.ps1");
const doctor = read("tools/doctor.mjs");
const packageJson = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const manifest = JSON.parse(read("runtime/manifest.json"));
const daemon = read("tools/daemon-setup.sh");

for (const [name, installer] of [["install.sh", sh], ["install.ps1", ps]]) {
  assert.match(installer, /1\.43\.1/, `${name} pins the package version`);
  assert.match(installer, /v2\.0\.0/, `${name} pins the public source release`);
  assert.match(installer, /ci[\s\S]*?--ignore-scripts/, `${name} installs the lockfile without postinstall`);
  assert.match(installer, /apply-patches\.mjs[\s\S]*?--package-dir/, `${name} applies the runtime manifest`);
  assert.match(installer, /apply-patches\.mjs[\s\S]*?--check/, `${name} verifies the runtime manifest`);
  assert.match(installer, /server\.backup-/, `${name} preserves the previous runtime on update`);
  assert.match(installer, /runtime-only|RuntimeOnly/i, `${name} offers an auth-free installer test mode`);
  assert.match(installer, /doctor\.mjs/, `${name} preserves the legacy doctor entrypoint`);
  assert.match(installer, /--status/, `${name} checks the authenticated read-only status before success`);
}

assert.match(sh, /api\.github\.com\/repos\/\$SOURCE_REPOSITORY\/commits\/\$SOURCE_VERSION/);
assert.match(sh, /github\.com\/\$SOURCE_REPOSITORY\/archive\/\$SOURCE_COMMIT\.tar\.gz/);
assert.match(ps, /api\.github\.com\/repos\/\$SourceRepository\/commits\/\$SourceVersion/);
assert.match(ps, /github\.com\/\$SourceRepository\/archive\/\$SourceCommit\.tar\.gz/);
assert.match(ps, /read-lockfile\.cjs/);
assert.doesNotMatch(ps, /& \$NodeBin\s+-e\b/, "PowerShell 5.1 does not inline Node code with quote-sensitive array keys");
assert.match(sh, /runtime\/source-receipt\.json/);
assert.match(ps, /runtime\\source-receipt\.json/);
assert.doesNotMatch(sh, /archive\/refs\/tags\//);
assert.doesNotMatch(ps, /archive\/refs\/tags\//);
assert.match(doctor, /manifest\.files/);
assert.match(doctor, /source-receipt\.json/);
assert.match(doctor, /receipt\.commitSHA/);
assert.equal(manifest.packageName, "@overpod/mcp-telegram");
assert.equal(manifest.telegramDependency.packageName, "teleproto");
assert.equal(manifest.telegramDependency.version, "1.229.0");
assert.equal(manifest.telegramDependency.alias, "telegram");
assert.match(doctor, /postimageSha256/);
assert.match(doctor, /const env = \{\}/, "doctor starts both modes with an empty child environment");
assert.match(doctor, /safeEnvironmentNames/);
assert.doesNotMatch(doctor, /\.\.\.process\.env/, "doctor never forwards the caller environment wholesale");
assert.doesNotMatch(doctor, /console\.log\(text\)/, "doctor does not print raw telegram-status identity details");
assert.match(doctor, /TELEGRAM_MCP_NO_AUTH = "1"/);
assert.match(doctor, /TELEGRAM_PROXY_IP = "127\.0\.0\.1"/);
assert.match(doctor, /TELEGRAM_PROXY_PORT = "9"/);
assert.match(doctor, /TELEGRAM_PROXY_SOCKS_TYPE = "5"/);
assert.match(doctor, /TELEGRAM_API_HASH = "invalid-fixture"/);
assert.doesNotMatch(doctor, /"0"\.repeat\(32\)/);
assert.match(sh, /TELEGRAM_MCP_NO_AUTH:-0/);
assert.match(ps, /TELEGRAM_MCP_NO_AUTH%/);
assert.match(doctor, /const status = await client\.callTool/);
assert.match(doctor, /if \(statusMode\)/);
assert.match(daemon, /ExecStart="\$RUN_UNIT" serve/);
assert.match(daemon, /wait_for_owner_restart/);
const daemonPs = read("tools/daemon-setup.ps1");
assert.match(daemonPs, /Wait-ForNewOwner/);
assert.match(daemonPs, /System\.Text\.UnicodeEncoding/);
assert.match(daemonPs, /WriteAllText/);
assert.doesNotMatch(daemonPs, /daemon\.vbs[\s\S]*?Encoding Ascii/);
assert.match(read("tests/installer-vbs-encoding.mjs"), /UTF-16LE BOM/);
assert.match(doctor, /tools\.tools\.length < minimumTools/);
assert.match(doctor, /telegram-status подтвердил авторизованное подключение/);
assert.equal(packageJson.version, "2.0.0");
assert.equal(packageJson.dependencies["@overpod/mcp-telegram"], "1.43.1");
assert.equal(packageJson.overrides.telegram, "npm:teleproto@1.229.0");
assert.equal(lock.packages["node_modules/@overpod/mcp-telegram"].version, "1.43.1");
assert.equal(lock.packages["node_modules/@overpod/mcp-telegram/node_modules/telegram"].version, "1.229.0");
assert.equal(lock.packages["node_modules/playwright"].version, "1.62.1");

for (const name of readdirSync(new URL("../configs/", import.meta.url)).filter((entry) => entry.endsWith(".json"))) {
  JSON.parse(read(`configs/${name}`));
}

console.log("Installer contract PASS: pinned source/runtime, no postinstall, staging rollback, manifest validation, no-auth doctor default, config JSON.");
