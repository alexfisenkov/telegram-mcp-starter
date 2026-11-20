// Telegram MCP Starter (A11): one scenario of a destroyed client against the real teleproto 1.233
// sender (Session) and the real TelegramClient on a fake connection. No network and no account
// key (the key is 256 bytes of sevens).
//   node tests/support/sender-seal-scenario.mjs <package-dir> <scenario> [--seal]
// Windows teleproto 1.233 closed itself (abort of the Session.supervise loop), kept as regressions:
//   retry-window   - the link drops, the network is down, the client is destroyed mid-retries,
//                    then the network comes back;
//   dialing        - destroyed while the reconnect TCP dial is still running;
//   reconnect-wait - destroyed while the reconnect waits for its throttle.
// Windows only the seal closes:
//   pool-after-destroy - a real TelegramClient raises a pool connection on the main DC and is
//                        destroyed in the same tick: without the seal the pool dials a NEW
//                        connection on the same key;
//   status             - supervise writes "connected" after disconnect() (open() -> setStatus window).
// Prints JSON: live connections, lifecycle, whether IO is alive, dials total and after destroy.
// --seal loads dist/telegram-client.js, which installs the A11 seal on Session.prototype.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDir = resolve(process.argv[2]);
const scenario = process.argv[3];
const sealed = process.argv.includes('--seal');
const req = createRequire(join(packageDir, 'package.json'));
const { TelegramClient } = req('telegram'); // the root first: teleproto TL has circular imports
const { MTProtoSender: Session } = req('telegram/network/MTProtoSender.js');
const { AuthKey } = req('telegram/crypto/AuthKey.js');
const { Logger, LogLevel } = req('telegram/extensions/Logger.js');
if (sealed) {
  const { fisSealStatus } = await import(pathToFileURL(join(packageDir, 'dist/telegram-client.js')));
  if (fisSealStatus() !== 'session') {
    console.log(JSON.stringify({ error: 'seal not installed', seal: fisSealStatus() }));
    process.exit(0);
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quiet = new Logger(LogLevel.NONE);

const net = { up: true, dialMs: 5, dials: 0, afterDestroy: 0, peakAfterDestroy: 0, destroyed: false, live: new Set() };
class FakeConnection {
  constructor(options = {}) { this._ip = options.ip; this._port = options.port; this._dcId = options.dcId; this.connected = false; this.waiters = []; this.socket = { lastDataAt: 0 }; }
  get usesRandomPadding() { return false; }
  isConnected() { return this.connected; }
  toString() { return 'fake-socket'; }
  clone() { return new FakeConnection({ ip: this._ip, port: this._port, dcId: this._dcId }); }
  async connect() {
    net.dials += 1;
    if (net.destroyed) net.afterDestroy += 1;
    await sleep(net.dialMs);
    if (!net.up) throw new Error('ECONNREFUSED (fake network is down)');
    this.connected = true;
    net.live.add(this);
    if (net.destroyed) net.peakAfterDestroy = Math.max(net.peakAfterDestroy, net.live.size);
  }
  async disconnect() { this.connected = false; net.live.delete(this); for (const w of this.waiters.splice(0)) w.reject(new Error('closed')); }
  recv() { return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }
  async send() {}
  drop() { this.connected = false; net.live.delete(this); for (const w of this.waiters.splice(0)) w.reject(new Error('ECONNRESET')); }
}
// A pause between attempts instead of the real ConnectThrottle (seconds): same windows, shorter.
const throttle = (ms) => ({ last: 0, setOnline() {}, nextAttemptAt() { return this.last ? this.last + ms : 0; },
  attempt() { this.last = Date.now(); }, connected() {}, transportFlooded() {}, networkChanged() {} });
const key = new AuthKey();
await key.setKey(Buffer.alloc(256, 7));
const current = () => [...net.live][0];
const summary = (sender) => ({ live: net.live.size, lifecycle: sender?.lifecycle, io: !!(sender?.link && !sender.link.isClosed),
  dials: net.dials, afterDestroy: net.afterDestroy, peakAfterDestroy: net.peakAfterDestroy });

async function mainSender(ms) {
  const client = { _destroyed: false };
  const sender = new Session(key, { logger: quiet, dcId: 2, retries: 1000, reconnectRetries: Infinity, autoReconnect: true,
    isMainSender: true, client, connectTimeout: 10, throttle: throttle(ms) });
  await sender.connect(new FakeConnection({ ip: '127.0.0.1', port: 443, dcId: 2 }));
  const destroy = async () => { client._destroyed = true; net.destroyed = true; await sender.disconnect(); };
  return { sender, destroy };
}

let sender;
if (scenario === 'retry-window') {
  const main = await mainSender(100); sender = main.sender;
  net.up = false;
  current().drop();
  await sleep(250);
  await main.destroy();
  net.up = true;
  await sleep(1500);
} else if (scenario === 'dialing') {
  const main = await mainSender(0); sender = main.sender;
  net.dialMs = 400;
  current().drop();
  await sleep(150);
  await main.destroy();
  await sleep(1000);
} else if (scenario === 'reconnect-wait') {
  const main = await mainSender(1000); sender = main.sender;
  current().drop();
  await sleep(1200);
  current()?.drop();
  await sleep(100);
  await main.destroy();
  await sleep(1800);
} else if (scenario === 'status') {
  const main = await mainSender(0); sender = main.sender;
  await main.destroy();
  sender.setStatus('connected');
} else if (scenario === 'pool-after-destroy') {
  const { StringSession } = req('telegram/sessions/index.js');
  const seed = new StringSession('');
  seed.setDC(2, '149.154.167.51', 443);
  await seed.load();
  seed.authKey = key;
  const client = new TelegramClient(new StringSession(seed.save()), 1, '0'.repeat(32), { connection: FakeConnection, baseLogger: quiet, connectionRetries: 1 });
  await client.session.load();
  const pooled = client.getSender(2).then((value) => { sender = value; }, () => {});
  net.destroyed = true;
  const ending = client.destroy();
  await sleep(800);
  await ending;
  await pooled;
} else {
  console.error('unknown scenario');
  process.exit(2);
}
console.log(JSON.stringify(summary(sender)));
process.exit(0);
