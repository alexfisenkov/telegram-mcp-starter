#!/usr/bin/env node
// Runs the real runtime-only installer against an isolated source archive and fake home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "telegram-installer-smoke-"));
const npmCache = join(temporaryRoot, "npm cache with spaces");
const sourceGit = join(temporaryRoot, "archive source");
const archive = join(temporaryRoot, process.platform === "win32" ? "pinned source.zip" : "pinned source.tar.gz");
const npmUserConfig = join(temporaryRoot, "empty npm user config");
const npmGlobalConfig = join(temporaryRoot, "empty npm global config");
writeFileSync(npmUserConfig, "", "utf8");
writeFileSync(npmGlobalConfig, "", "utf8");
const sourceRepo = "alexfisenkov/telegram-mcp-starter";
const filesToCopy = [
  "package.json", "package-lock.json", "runtime",
  "tools/apply-patches.mjs", "tools/doctor.mjs", "tools/merge-config.mjs",
  "tools/daemon-setup.sh", "tools/daemon-setup.ps1",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function makeSourceArchive() {
  mkdirSync(sourceGit, { recursive: true });
  for (const relativePath of filesToCopy) {
    const source = join(projectRoot, relativePath);
    const target = join(sourceGit, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  execFileSync("git", ["init", "-q"], { cwd: sourceGit });
  execFileSync("git", ["config", "user.name", "Installer Smoke"], { cwd: sourceGit });
  execFileSync("git", ["config", "user.email", "installer-smoke@example.invalid"], { cwd: sourceGit });
  execFileSync("git", ["add", "--all"], { cwd: sourceGit });
  execFileSync("git", ["commit", "-q", "-m", "isolated installer smoke source"], { cwd: sourceGit });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceGit, encoding: "utf8" }).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  const archiveFormat = process.platform === "win32" ? "zip" : "tar.gz";
  execFileSync("git", ["archive", `--format=${archiveFormat}`, "--prefix=telegram-mcp-starter-source/", `--output=${archive}`, commit], { cwd: sourceGit });
  return commit;
}

function makeEnvironment(userHome) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(TELEGRAM_|MCP_TELEGRAM_|TELEGRAM_MCP_)/i.test(key)) delete env[key];
  }
  env.HOME = userHome;
  env.USERPROFILE = userHome;
  env.APPDATA = join(userHome, "AppData", "Roaming");
  env.LOCALAPPDATA = join(userHome, "AppData", "Local");
  env.TMPDIR = process.platform === "win32" ? temporaryRoot : "/tmp";
  env.TEMP = temporaryRoot;
  env.TMP = temporaryRoot;
  env.npm_config_cache = npmCache;
  env.npm_config_userconfig = npmUserConfig;
  env.npm_config_globalconfig = npmGlobalConfig;
  env.npm_config_registry = "https://registry.npmjs.org/";
  return env;
}

async function exerciseInstaller(kind, commit) {
  const userHome = join(temporaryRoot, `${kind} fake home`);
  const installRoot = join(userHome, "Папка установки с пробелами");
  const clientConfig = join(userHome, "client config.json");
  mkdirSync(join(installRoot, "server"), { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const envBytes = Buffer.from("TELEGRAM_API_ID=dummy-fixture\nTELEGRAM_API_HASH=dummy-fixture\n", "utf8");
  const sessionBytes = Buffer.from("synthetic existing session marker\n", "utf8");
  const configBytes = Buffer.from('{"mcpServers":{"other":{"command":"keep"}}}\n', "utf8");
  const oldServerBytes = Buffer.from("old server marker\n", "utf8");
  writeFileSync(join(installRoot, "telegram.env"), envBytes);
  writeFileSync(join(installRoot, "session"), sessionBytes);
  writeFileSync(clientConfig, configBytes);
  writeFileSync(join(installRoot, "server", "old-runtime-marker"), oldServerBytes);

  const env = makeEnvironment(userHome);
  let installerOutput;
  if (kind === "bash") {
    installerOutput = run("bash", [
      "install.sh", "--runtime-only", "--install-root", installRoot,
      "--source-archive", archive, "--source-commit", commit,
    ], { env });
  } else {
    const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
    installerOutput = run(shell, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1",
      "-RuntimeOnly", "-InstallRoot", installRoot,
      "-SourceArchive", archive, "-SourceCommit", commit,
    ], { env });
  }

  const server = join(installRoot, "server");
  assert.equal(readFileSync(join(installRoot, "telegram.env")).compare(envBytes), 0, `${kind} preserved telegram.env`);
  assert.equal(readFileSync(join(installRoot, "session")).compare(sessionBytes), 0, `${kind} preserved the existing session marker`);
  assert.equal(readFileSync(clientConfig).compare(configBytes), 0, `${kind} left client config unchanged`);
  assert.equal(existsSync(join(server, "old-runtime-marker")), false, `${kind} activated the staged server; listing=${readdirSync(server).join(",")}; output=${installerOutput}`);
  const backups = readdirSync(installRoot).filter((name) => name.startsWith("server.backup-"));
  assert.equal(backups.length, 1, `${kind} preserved one prior server backup`);
  assert.equal(readFileSync(join(installRoot, backups[0], "old-runtime-marker")).compare(oldServerBytes), 0);
  const receipt = JSON.parse(readFileSync(join(server, "runtime", "source-receipt.json"), "utf8"));
  assert.deepEqual(receipt, { repository: sourceRepo, version: "v2.0.0", commitSHA: commit });

  const packageDir = join(server, "node_modules", "@overpod", "mcp-telegram");
  run(process.execPath, [join(server, "tools", "apply-patches.mjs"), "--package-dir", packageDir, "--check"], { env });
  const manifest = JSON.parse(readFileSync(join(server, "runtime", "manifest.json"), "utf8"));
  for (const file of manifest.files) {
    const actual = createHash("sha256").update(readFileSync(join(packageDir, file.path))).digest("hex");
    assert.equal(actual, file.postimageSha256, `${kind} left ${file.path} at the manifest postimage; installer output=${installerOutput}`);
  }
  const cli = join(packageDir, "dist", "cli.js");
  const doctorOutput = run(process.execPath, [join(server, "tools", "doctor.mjs"), process.execPath, cli], { env });
  assert.match(doctorOutput, /Runtime manifest подтверждён/);
  assert.match(doctorOutput, /initialize \+ tools\/list прошли без вызова инструментов/);
  assert.equal(existsSync(join(userHome, "Library", "LaunchAgents", "com.telegram-mcp.daemon.plist")), false);
  assert.equal(existsSync(join(userHome, ".config", "systemd", "user", "telegram-mcp.service")), false);
}

try {
  const commit = makeSourceArchive();
  const installers = [];
  if (process.platform === "win32") {
    installers.push("powershell");
  } else {
    installers.push("bash");
    const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
    if (pwsh.status === 0) installers.push("powershell");
  }
  for (const installer of installers) {
    process.stdout.write(`Smoke: ${installer} runtime-only install in isolated Unicode path…\n`);
    await exerciseInstaller(installer, commit);
  }
  console.log(`Installer smoke PASS: ${installers.join(" + ")}; source commit ${commit}; no Telegram auth or service setup.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
