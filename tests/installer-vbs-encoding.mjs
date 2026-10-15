#!/usr/bin/env node
// Writes the production VBS fixture through the real PowerShell helper, without registering a task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(projectRoot, "tools", "daemon-setup.ps1");
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const temporaryRoot = mkdtempSync(join(tmpdir(), "telegram-vbs-encoding-"));
const fixturePath = join(temporaryRoot, "daemon с пробелом.vbs");
const runCommand = "C:\\Users\\Тест Пользователь\\.telegram-mcp\\run.cmd";

try {
  const result = spawnSync(shell, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Cmd", "vbs-fixture", "-TestRunCommand", runCommand, "-TestVbsPath", fixturePath,
  ], { cwd: projectRoot, env: { ...process.env, USERPROFILE: temporaryRoot }, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${shell} fixture writer failed\n${result.stdout}\n${result.stderr}`);

  const bytes = readFileSync(fixturePath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "Windows Script Host receives a UTF-16LE BOM");
  const contents = bytes.subarray(2).toString("utf16le");
  assert.equal(contents, `CreateObject("WScript.Shell").Run """${runCommand}"" serve", 0, False`);
  assert.equal(contents.includes("\uFFFD"), false, "Unicode username is preserved without replacement characters");
  console.log(`VBS encoding PASS: ${shell} wrote UTF-16LE BOM and preserved Unicode/space path.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
