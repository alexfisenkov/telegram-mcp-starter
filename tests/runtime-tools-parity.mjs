import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches } from '../tools/apply-patches.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPackageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? join(projectRoot, 'node_modules/@overpod/mcp-telegram'));
const packageDir = join(dirname(upstreamPackageDir), `.telegram-mcp-starter-parity-${randomUUID()}`);
assert.equal(existsSync(join(upstreamPackageDir, '.telegram-session')), false, 'upstream package must not contain a Telegram session');
cpSync(upstreamPackageDir, packageDir, { recursive: true, errorOnExist: true, force: false });
const entry = join(packageDir, 'dist/cli.js');
const standardFixture = JSON.parse(readFileSync(join(projectRoot, 'tests/fixtures/runtime-tools-standard.json'), 'utf8'));
const allOptInFixture = JSON.parse(readFileSync(join(projectRoot, 'tests/fixtures/runtime-tools-all-opt-in.json'), 'utf8'));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function capture(profile, optionalFlags = {}) {
  const home = mkdtempSync(join(tmpdir(), 'telegram-mcp-tool-list-'));
  const sessionPath = join(home, 'session-that-must-not-exist');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    TELEGRAM_API_ID: '1',
    TELEGRAM_API_HASH: 'invalid-fixture',
    TELEGRAM_SESSION_PATH: sessionPath,
    TELEGRAM_PROXY_IP: '127.0.0.1',
    TELEGRAM_PROXY_PORT: '9',
    TELEGRAM_PROXY_SOCKS_TYPE: '5',
    ...optionalFlags,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.platform === 'win32' ? {
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
    } : {}),
  };
  const child = spawn(process.execPath, [entry], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const responses = new Map();
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      responses.set(message.id, message);
      const waiter = waiters.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const request = (method, params = {}) => {
    const id = nextId++;
    const existing = responses.get(id);
    if (existing) return Promise.resolve(existing);
    const promise = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        rejectRequest(new Error(`${profile} ${method} timed out; stderr bytes=${stderr.length}`));
      }, 30000);
      waiters.set(id, { resolve: resolveRequest, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'telegram-mcp-starter-schema-test', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `${profile} initializes without login`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    let cursor;
    const tools = [];
    do {
      const page = await request('tools/list', cursor ? { cursor } : {});
      assert.equal(page.error, undefined, `${profile} tools/list succeeds`);
      tools.push(...(page.result?.tools ?? []));
      cursor = page.result?.nextCursor;
    } while (cursor);

    assert.equal(existsSync(sessionPath), false, `${profile} probe did not create a Telegram session`);
    assert.equal(/(?:Connecting to|Connected to|DC \d|149\.154\.)/i.test(stderr), false,
      `${profile} probe did not log a Telegram endpoint; dead loopback SOCKS5 proxy is configured`);

    return {
      serverInfo: init.result?.serverInfo,
      tools: tools.map((tool) => canonical({
        name: tool.name,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations ?? {},
      })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
    for (const waiter of waiters.values()) clearTimeout(waiter.timer);
    rmSync(home, { recursive: true, force: true });
  }
}

try {
  applyPatches(packageDir);
  const standard = await capture('standard');
  const allOptIn = await capture('all-opt-in', {
    MCP_TELEGRAM_ENABLE_GROUP_CALLS: '1',
    MCP_TELEGRAM_ENABLE_STARS: '1',
    MCP_TELEGRAM_ENABLE_QUICK_REPLIES: '1',
  });
  assert.equal(standard.serverInfo?.version, '1.43.1');
  assert.equal(allOptIn.serverInfo?.version, '1.43.1');
  assert.deepEqual({
    schema: standardFixture.schema,
    packageVersion: standard.serverInfo.version,
    profile: 'standard',
    count: standard.tools.length,
    tools: standard.tools,
  }, standardFixture, 'standard names, schemas and annotations match the independent private reference fixture');
  assert.deepEqual({
    schema: allOptInFixture.schema,
    packageVersion: allOptIn.serverInfo.version,
    profile: 'all-opt-in',
    count: allOptIn.tools.length,
    tools: allOptIn.tools,
  }, allOptInFixture, 'all-opt-in names, schemas and annotations match the independent private reference fixture');

  const standardByName = new Map(standard.tools.map((tool) => [tool.name, tool]));
  const allOptInByName = new Map(allOptIn.tools.map((tool) => [tool.name, tool]));
  assert.equal([...standardByName.keys()].every((name) => allOptInByName.has(name)), true,
    'all-opt-in keeps the full standard tool set');
  for (const [name, tool] of standardByName) {
    assert.deepEqual(allOptInByName.get(name), tool, `${name} schema/annotations do not change when optional groups are enabled`);
  }
  assert.equal(allOptIn.tools.length - standard.tools.length, 13, 'all three optional groups add the reviewed 13 tools');
  console.log(`OK: pinned dist/cli.js schemas match private reference (${standard.tools.length}/${allOptIn.tools.length}); no session or Telegram endpoint used`);
} finally {
  rmSync(packageDir, { recursive: true, force: true });
}
