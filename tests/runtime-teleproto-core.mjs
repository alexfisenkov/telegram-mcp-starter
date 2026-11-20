// Telegram MCP Starter: the patches that follow the teleproto 1.233 network core (Session instead
// of MTProtoSender), checked against the real library on fake connections. No network, no
// session file, no account key (synthetic 256-byte keys only).
//   A11    - a destroyed client opens no connection on its key; every case that only the seal
//            closes has a control that fails without it;
//   A7-tp  - the key guard returns the saved key after a confirmed -404, including a QR-login
//            client (guard installed before connect(), with a control for the old order);
//   R4b    - TCP to the DC IP, main DC port useWSS ? 443 : 80, one media connection by default.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatches } from '../tools/apply-patches.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamPackageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? join(projectRoot, 'node_modules/@overpod/mcp-telegram'));
const packageDir = join(dirname(upstreamPackageDir), `.telegram-mcp-starter-core-${randomUUID()}`);
assert.equal(existsSync(join(upstreamPackageDir, '.telegram-session')), false, 'upstream package must not contain a Telegram session');
cpSync(upstreamPackageDir, packageDir, { recursive: true, errorOnExist: true, force: false });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (condition, ms = 3000) => {
  const started = Date.now();
  while (!condition() && Date.now() - started < ms) await sleep(10);
  return condition();
};

try {
  applyPatches(packageDir);
  const req = createRequire(join(packageDir, 'package.json'));
  assert.equal(req('telegram/package.json').name, 'teleproto');
  assert.equal(req('telegram/package.json').version, '1.233.0');
  const { TelegramClient } = req('telegram');
  const { StringSession } = req('telegram/sessions/index.js');
  const { AuthKey } = req('telegram/crypto/AuthKey.js');
  const { Logger, LogLevel } = req('telegram/extensions/Logger.js');
  const { InvalidBufferError } = req('telegram/errors/index.js');
  const { Api } = req('telegram/tl/index.js');
  const { fisClientOptions, fisSealStatus, TelegramService } = await import(pathToFileURL(join(packageDir, 'dist/telegram-client.js')));

  // --- A11: the seal is in place, and a destroyed client never comes back. ---
  assert.equal(fisSealStatus(), 'session', 'the A11 seal is installed on teleproto Session.prototype');
  const scenarioPath = join(projectRoot, 'tests/support/sender-seal-scenario.mjs');
  const scenario = (name, sealed) => {
    const run = spawnSync(process.execPath, [scenarioPath, packageDir, name, ...(sealed ? ['--seal'] : [])], { encoding: 'utf8', timeout: 30_000 });
    try { return JSON.parse(run.stdout.trim().split('\n').pop()); } catch { return { error: run.stderr.slice(-400) }; }
  };
  for (const name of ['retry-window', 'dialing', 'reconnect-wait']) {
    for (const sealed of [false, true]) {
      const r = scenario(name, sealed);
      assert.ok(r.live === 0 && r.lifecycle === 'dead' && r.io === false && r.afterDestroy === 0 && r.dials >= 2,
        `${name}${sealed ? ' with the seal' : ' without the seal (closed by teleproto 1.233)'}: no live sender and no dial after destroy: ${JSON.stringify(r)}`);
    }
  }
  const poolOpen = scenario('pool-after-destroy', false);
  assert.ok(poolOpen.afterDestroy >= 1 && poolOpen.peakAfterDestroy >= 1,
    `control: without the seal the pool of a destroyed client dials a new connection on its key: ${JSON.stringify(poolOpen)}`);
  const poolSealed = scenario('pool-after-destroy', true);
  assert.ok(poolSealed.afterDestroy === 0 && poolSealed.dials === 0 && poolSealed.live === 0,
    `with the seal a destroyed client opens no connection: ${JSON.stringify(poolSealed)}`);
  const statusOpen = scenario('status', false);
  assert.equal(statusOpen.lifecycle, 'connected', `control: without the seal a dead sender reports connected: ${JSON.stringify(statusOpen)}`);
  const statusSealed = scenario('status', true);
  assert.ok(statusSealed.lifecycle === 'dead' && statusSealed.live === 0, `with the seal a destroyed sender stays dead: ${JSON.stringify(statusSealed)}`);

  // --- A7-tp: the key guard on the 1.233 core. ---
  process.env.TELEGRAM_KEY_RESET_PAUSE_MS = '5';
  process.env.TELEGRAM_KEY_PROBE_MS = '5';
  const keyBytes = Buffer.alloc(256, 7);
  const seed = new StringSession('');
  seed.setDC(2, '149.154.167.51', 443);
  await seed.load();
  { const ak = new AuthKey(); await ak.setKey(keyBytes); seed.authKey = ak; }
  const sessionString = seed.save();
  const quiet = new Logger(LogLevel.NONE);
  const rpcError = (name, code) => Object.assign(new Error(`${code}: ${name}`), { errorMessage: name, code });
  const guarded = async (fakeInvoke) => {
    const s = Object.create(TelegramService.prototype);
    const c = new TelegramClient(new StringSession(sessionString), 1, '0'.repeat(32), { connectionRetries: 0, baseLogger: quiet });
    await c.session.load();
    if (fakeInvoke) c.invoke = fakeInvoke; // before the guard: it wraps the instance invoke
    s.client = c; s.connected = true; s.sessionDead = false; s.sessionString = sessionString;
    s.installFatalErrorHandler(c);
    return { s, c };
  };
  {
    const { s, c } = await guarded();
    let probes = 0;
    c.getMe = async () => { probes += 1; };
    const ak = c.session.getAuthKey(2);
    await ak.setKey(undefined); // what teleproto does on a confirmed -404 before the callback
    await c._authKeyCallback(undefined, 2);
    await sleep(40);
    assert.ok(s.sessionDead === false && Buffer.compare(ak.getKey() ?? Buffer.alloc(0), keyBytes) === 0 && probes === 1,
      'one -404: the saved key is put back (no DH), the session lives, getMe probes it');
    await ak.setKey(undefined); await c._authKeyCallback(undefined, 2);
    assert.equal(s.sessionDead, false, 'a second -404 within 10 minutes retries the same key');
    await ak.setKey(undefined); await c._authKeyCallback(undefined, 2);
    assert.ok(s.sessionDead === true && s.client === null, 'a third -404 within 10 minutes ends the session');
  }
  {
    const { s, c } = await guarded(async () => { throw rpcError('AUTH_KEY_UNREGISTERED', 401); });
    c.getMe = async () => c.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
    await c.session.getAuthKey(2).setKey(undefined);
    await c._authKeyCallback(undefined, 2);
    await sleep(40);
    assert.equal(s.sessionDeadReason, 'AUTH_KEY_UNREGISTERED', 'a -404 confirmed by the getMe probe ends the session');
  }
  {
    const { s, c } = await guarded();
    const other = new AuthKey(); await other.setKey(Buffer.alloc(256, 1));
    await c._authKeyCallback(other, 2);
    assert.ok(s.sessionDead === true && /REKEYED/.test(s.sessionDeadReason), 'a new main-DC key issued by the library ends the session');
  }
  {
    const { s, c } = await guarded();
    await c._authKeyCallback(undefined, 4);
    assert.equal(s.sessionDead, false, 'a key reset on another DC is not fatal');
    s.client = null; c._fisSealed = true; await c.destroy().catch(() => {});
  }
  for (const [name, code, fatal] of [['PEER_ID_INVALID', 400, false], ['USER_DEACTIVATED', 401, true], ['AUTH_KEY_DUPLICATED', 406, true]]) {
    const { s, c } = await guarded(async () => { throw rpcError(name, code); });
    await assert.rejects(c.invoke(new Api.help.GetConfig()));
    assert.equal(s.sessionDead, fatal, `invoke ${code} ${name}: ${fatal ? 'fatal' : 'not fatal'}, error rethrown`);
    if (!s.sessionDead) { s.client = null; c._fisSealed = true; await c.destroy().catch(() => {}); }
  }

  // Through the real Session: a transport -404 (Session.onBadKey). The first opens a new MTProto
  // session on the same key; the second validates the key (here: the server does not know it),
  // erases it and calls _authKeyCallback(undefined). With the guard the saved key is back and the
  // reconnect needs no DH; without it the key is empty and a new DH starts.
  const live = new Set();
  class FakeConnection {
    constructor(options = {}) { this.options = options; this.waiters = []; this.socket = { lastDataAt: 0 }; }
    get usesRandomPadding() { return false; }
    toString() { return 'fake-connection'; }
    clone() { return new FakeConnection(this.options); }
    async connect() { await sleep(2); live.add(this); }
    async disconnect() { live.delete(this); for (const w of this.waiters.splice(0)) w.reject(new Error('closed')); }
    recv() { return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
    async send() {}
    fail(error) { for (const w of this.waiters.splice(0)) w.reject(error); }
  }
  const badKey = () => { const b = Buffer.alloc(4); b.writeInt32LE(-404, 0); return new InvalidBufferError(b); };
  // mode: none - no guard; connect - as connectOnce (guard before connect); qr-guard-after-connect -
  // the old QR order (guard after connect, Session already took the original callback); qr - the
  // key guard before connect, the client becomes this.client after the login.
  const throughCore = async (mode) => {
    const guard = mode === 'connect' || mode === 'qr';
    const qr = mode.startsWith('qr');
    live.clear();
    const s = Object.create(TelegramService.prototype);
    const c = new TelegramClient(new StringSession(sessionString), 1, '0'.repeat(32), { connectionRetries: 1, connection: FakeConnection, baseLogger: quiet });
    await c.session.load();
    s.client = qr ? { previous: true } : c; s.connected = true; s.sessionDead = false; s.sessionString = sessionString;
    if (mode === 'connect') s.installFatalErrorHandler(c);
    if (mode === 'qr') s.fisInstallKeyGuard(c);
    c._validateAuthKey = async () => false;
    c.connect().catch(() => {}); // GetConfig never answers, connect() need not finish
    await waitFor(() => c._sender?.lifecycle === 'connected');
    if (qr) { s.client = c; s.installFatalErrorHandler(c); }
    const sender = c._sender;
    const reset = async (ms) => {
      const before = [...live][0];
      before?.fail(badKey());
      await waitFor(() => !live.has(before));
      return waitFor(() => sender.lifecycle === 'connected' && live.size === 1, ms);
    };
    const first = await reset(3000);
    const afterFirst = sender.keyRejections;
    await reset(guard ? 3000 : 600);
    const result = { first, afterFirst, lifecycle: sender.lifecycle, rejections: sender.keyRejections, dead: s.sessionDead,
      key: Buffer.compare(sender.authKey.getKey() ?? Buffer.alloc(0), keyBytes) === 0,
      inSession: Buffer.compare(c.session.getAuthKey(2)?.getKey() ?? Buffer.alloc(0), keyBytes) === 0 };
    s.client = null; c._fisSealed = true; await c.destroy().catch(() => {});
    return result;
  };
  const none = await throughCore('none');
  assert.ok(none.first && none.afterFirst === 1 && !none.key && none.lifecycle !== 'connected',
    `control: without the guard a confirmed -404 erases the key and starts a new DH: ${JSON.stringify(none)}`);
  const main = await throughCore('connect');
  assert.ok(main.first && main.afterFirst === 1 && main.rejections === 2 && main.key && main.inSession && main.lifecycle === 'connected' && main.dead === false,
    `with the guard the saved key is back, the reconnect needs no DH, the session lives: ${JSON.stringify(main)}`);
  const qrOld = await throughCore('qr-guard-after-connect');
  assert.ok(qrOld.first && !qrOld.key && qrOld.lifecycle !== 'connected',
    `control: a guard installed after connect() never fires, the key is erased: ${JSON.stringify(qrOld)}`);
  const qrNew = await throughCore('qr');
  assert.ok(qrNew.first && qrNew.rejections === 2 && qrNew.key && qrNew.inSession && qrNew.lifecycle === 'connected' && qrNew.dead === false,
    `after a QR login the key guard installed before connect() puts the key back: ${JSON.stringify(qrNew)}`);
  const qrSource = TelegramService.prototype.startQrLoginOnce.toString();
  const guardAt = qrSource.indexOf('this.fisInstallKeyGuard(client)');
  assert.ok(guardAt > 0 && guardAt < qrSource.indexOf('await client.connect()'), 'startQrLoginOnce installs the key guard before client.connect()');
  const refusalAt = qrSource.indexOf('fisSealRefusal()');
  assert.ok(refusalAt > 0 && refusalAt < qrSource.indexOf('await client.connect()'), 'startQrLoginOnce refuses to connect without the seal');
  delete process.env.TELEGRAM_KEY_RESET_PAUSE_MS;
  delete process.env.TELEGRAM_KEY_PROBE_MS;

  // --- R4b: transport and media pool as before the move. ---
  {
    const plainSeed = new StringSession('');
    plainSeed.setDC(2, '149.154.167.51', 80);
    await plainSeed.load();
    { const ak = new AuthKey(); await ak.setKey(Buffer.alloc(256, 9)); plainSeed.authKey = ak; }
    const saved = plainSeed.save();
    const wss = new StringSession(saved), plain = new StringSession(saved);
    const withWss = fisClientOptions(true, wss), withoutWss = fisClientOptions(false, plain);
    assert.ok(!('networkSocket' in withWss) && !('useWSS' in withWss) && !('transport' in withWss), 'WSS does not switch on a WebSocket transport');
    assert.deepEqual([wss.port, plain.port, wss.serverAddress], [443, 80, '149.154.167.51'], 'main DC port: useWSS -> 443, else 80; the address stays an IP');
    const c = new TelegramClient(wss, 1, '0'.repeat(32), { connectionRetries: 0, baseLogger: quiet, ...withWss });
    await c._initSession();
    const { NetSocket } = req('telegram/network/transport/socket/NetSocket.js');
    const connection = c._createConnection({ id: c.session.dcId, ipAddress: c.session.serverAddress, port: c.session.port || 443 });
    assert.ok(c._transport.socket === NetSocket && !c._transport.webSocket && connection.rawSocket instanceof NetSocket
      && connection.ip === '149.154.167.51' && connection.port === 443, 'TCP socket to the DC IP on port 443');
    const reread = new StringSession(c.session.save()); await reread.load();
    assert.equal(reread.serverAddress, '149.154.167.51', 'the saved session keeps the IP address');
    assert.deepEqual(withWss.downloadPool, { sessions: 1 }, 'one media connection per DC by default');
    assert.deepEqual([c._files.sessionCount('download', 2), c._files.sessionCount('upload', 2)], [1, 1], 'teleproto 1.233 honours the pool size');
    process.env.TELEGRAM_MEDIA_SESSIONS = '4';
    assert.equal(fisClientOptions(false).downloadPool.sessions, 4, 'TELEGRAM_MEDIA_SESSIONS sets the pool size');
    delete process.env.TELEGRAM_MEDIA_SESSIONS;
  }

  console.log('OK: teleproto 1.233 core - A11 seal with controls, A7-tp key guard incl. QR login with control, R4b transport and media pool');
} finally {
  rmSync(packageDir, { recursive: true, force: true });
}
process.exit(0);
