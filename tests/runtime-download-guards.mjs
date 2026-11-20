import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { applyPatches } from '../tools/apply-patches.mjs';

const upstreamPackageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? 'node_modules/@overpod/mcp-telegram');
const packageDir = join(dirname(upstreamPackageDir), `.telegram-mcp-starter-download-${randomUUID()}`);
cpSync(upstreamPackageDir, packageDir, { recursive: true, errorOnExist: true, force: false });
const dir = mkdtempSync(join(tmpdir(), 'telegram-download-guards-'));
const PART = 512 * 1024;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const settle = (promise, ms, what) => Promise.race([
  promise.then((value) => ({ value }), (error) => ({ error })),
  pause(ms).then(() => { throw new Error(`HUNG: ${what} took longer than ${ms} ms`); }),
]);

try {
  applyPatches(packageDir);
  const requireFromPackage = createRequire(resolve(packageDir, 'package.json'));
  const bigInt = requireFromPackage('big-integer');
  const { Api } = requireFromPackage('telegram/tl/index.js');
  // The real downloadFile runs here: its writer close is what used to wait forever.
  const { downloadFile } = requireFromPackage('telegram/client/downloads.js');
  const { TelegramService } = await import(pathToFileURL(resolve(packageDir, 'dist/telegram-client.js')));
  const { registerMediaTools } = await import(pathToFileURL(resolve(packageDir, 'dist/tools/media.js')));
  const { handleClient } = await import(pathToFileURL(resolve(packageDir, 'dist/master.js')));
  const { encodeMessage } = await import(pathToFileURL(resolve(packageDir, 'dist/ipc-protocol.js')));

  // teleproto 1.233: file parts go through the real FileTransfers (queue, FLOOD_WAIT sleep,
  // cancellation) over a pool slot. Only the slot is faked; getFile plays the server.
  const { FileTransfers } = requireFromPackage('telegram/client/files/FileTransfers.js');
  const { RPCMessageToError } = requireFromPackage('telegram/errors/index.js');
  const { Logger, LogLevel } = requireFromPackage('telegram/extensions/Logger.js');
  const location = () => new Api.InputDocumentFileLocation({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), thumbSize: '' });
  const floodError = (seconds) => RPCMessageToError({ errorMessage: `FLOOD_WAIT_${seconds}`, errorCode: 420 },
    new Api.upload.GetFile({ location: location(), offset: bigInt(0), limit: PART }));
  const service = (getFile) => {
    const session = {
      addStateToQueue(state) {
        Promise.resolve().then(() => getFile(state.request)).then(
          (bytes) => state.resolve(new Api.upload.File({ type: new Api.storage.FileUnknown(), mtime: 0, bytes })),
          (error) => state.reject(error));
      },
      cancelRequest(state, reason) { state.reject(reason); },
    };
    const slot = { load: 0, enter() {}, leave() {}, onDeath() { return () => {}; }, ensureConnected: async () => session };
    const client = {
      session: { dcId: 2 }, _log: new Logger(LogLevel.NONE), _premium: false, _bot: false,
      _getAppConfig: async () => ({}), _network: { getSession: () => slot }, _addresses: { isCdn: () => false },
    };
    client._files = new FileTransfers(client, { partSize: PART, sessions: 1 });
    const instance = Object.create(TelegramService.prototype);
    instance.connected = true;
    instance.unhealthy = [];
    instance.markUnhealthy = (reason) => instance.unhealthy.push(reason);
    instance.resolvePeer = async () => ({});
    instance.client = {
      getMessages: async () => [{ media: {}, photo: {} }],
      downloadMedia: (_message, { outputFile, progressCallback, signal }) => downloadFile(client, location(), { outputFile, progressCallback, signal }),
    };
    return instance;
  };
  // A file of a given length: the server answers the [offset, offset+limit) slice of upload.GetFile.
  const sized = (length, byte = 7) => async (request) => Buffer.alloc(Math.max(0, Math.min(request.limit, length - Number(request.offset))), byte);
  const leftovers = () => readdirSync(dir).filter((name) => name.endsWith('.part'));

  // A path the server cannot write answers with words and never asks Telegram for the file.
  let requests = 0;
  const unwritable = await settle(service(async () => { requests += 1; return Buffer.alloc(0); })
    .downloadMedia('1', 1, join(dir, 'missing-folder', 'x.jpg')), 3000, 'write to a missing folder');
  assert.match(unwritable.error?.message ?? '', /ENOENT/);
  assert.match(unwritable.error.message, /downloadPath/);
  assert.equal(requests, 0);

  // A stream that dies mid-download ends the call instead of hanging it.
  const breaking = service(async (request) => { await pause(5); return Buffer.alloc(request.limit, 1); });
  const original = breaking.client.downloadMedia;
  breaking.client.downloadMedia = (message, params) => {
    setTimeout(() => params.outputFile.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })), 20);
    return original(message, params);
  };
  const broken = await settle(breaking.downloadMedia('1', 2, join(dir, 'full.bin')), 3000, 'write to a full disk');
  assert.match(broken.error?.message ?? '', /ENOSPC/);
  assert.equal(existsSync(join(dir, 'full.bin')), false);
  assert.deepEqual(leftovers(), []);

  // teleproto's texts about the connection and floods stay retryable at the tool's exit.
  const failing = {};
  const failures = [
    Object.assign(new Error('Media request deadline exceeded'), { errorMessage: 'TIMEOUT' }),
    new Error('Cannot send requests while disconnected.'),
    Object.assign(new Error('Please wait 120 seconds before repeating the action.'), { seconds: 120 }),
    new Error('Message 3 has no media'),
  ];
  registerMediaTools({ registerTool(name, _spec, handler) { failing[name] = handler; } }, {
    ensureConnected: async () => true,
    downloadMedia: async (_chat, message) => { throw failures[message]; },
  });
  const exit = async (message) => (await failing['telegram-download-media']({ chatId: '1', messageId: message, downloadPath: join(dir, 'x.jpg') })).content[0].text;
  assert.match(await exit(0), /connection/);
  assert.match(await exit(1), /connection/);
  assert.match(await exit(2), /FLOOD_WAIT_120/);
  assert.equal(await exit(3), 'Error: Message 3 has no media');

  // A silent transport trips the watchdog, a slow but living one does not.
  process.env.TELEGRAM_DOWNLOAD_STALL_MS = '300';
  const silent = service(() => new Promise(() => {}));
  const stalled = await settle(silent.downloadMedia('1', 3, join(dir, 'silent.jpg')), 3000, 'silent transport');
  assert.match(stalled.error?.message ?? '', /connection/);
  assert.equal(silent.unhealthy.length, 1);
  assert.deepEqual(leftovers(), []);

  // A flood longer than the library budget (60 s) comes back at once as FLOOD_WAIT_<N>, no part re-asked.
  const longParts = [];
  const longFlooded = await settle(service(async (request) => { longParts.push(Number(request.offset)); throw floodError(3600); })
    .downloadMedia('1', 33, join(dir, 'long-flood.jpg')), 3000, 'a long media flood');
  assert.match(longFlooded.error?.message ?? '', /^FLOOD_WAIT_3600\b/);
  assert.equal(longFlooded.error.code, 420);
  assert.ok(longParts.length >= 1 && new Set(longParts).size === longParts.length, `no part is retried blindly: ${longParts}`);
  assert.deepEqual(leftovers(), []);

  // A short flood is slept out by FileTransfers: the 300 ms watchdog does not cut it and reports life.
  let floods = 0;
  const onePart = sized(PART);
  const flooded = service(async (request) => { if (!floods++) throw floodError(1); return onePart(request); });
  const alive = [];
  const shortFlood = await settle(flooded.downloadMedia('1', 32, join(dir, 'flood.jpg'), (received) => alive.push(received)), 5000, 'download under a short flood');
  assert.equal(shortFlood.value, join(dir, 'flood.jpg'), String(shortFlood.error));
  assert.ok(floods >= 2, 'the flooded part is asked again after the wait');
  assert.ok(alive.length >= 1, 'a call under flood reports life');
  assert.equal(flooded.unhealthy.length, 0);
  assert.deepEqual(leftovers(), []);

  // The flood mark belongs to one transfer: a flood of A never hides a real stall of B on the same client.
  let mode = 'long';
  const dataA = sized(PART);
  const shared = service(async (request) => {
    if (mode === 'long') throw floodError(300);
    if (mode === 'flood') throw floodError(2);
    if (mode === 'silent') return new Promise(() => {});
    return dataA(request);
  });
  const longA = await settle(shared.downloadMedia('1', 35, join(dir, 'a1.jpg')), 3000, 'long flood of A');
  assert.match(longA.error?.message ?? '', /^FLOOD_WAIT_300\b/);
  mode = 'silent';
  let started = Date.now();
  const stalledB1 = await settle(shared.downloadMedia('1', 36, join(dir, 'b1.jpg')), 3000, 'stall of B after a long flood of A');
  assert.match(stalledB1.error?.message ?? '', /без новых данных/, 'an abandoned flood of A does not hide the stall of B');
  assert.ok(Date.now() - started < 1500, `B is cut by its own watchdog: ${Date.now() - started} ms`);
  mode = 'flood';
  const pendingA = shared.downloadMedia('1', 37, join(dir, 'a2.jpg'));
  await pause(50);
  mode = 'silent';
  started = Date.now();
  const stalledB2 = await settle(shared.downloadMedia('1', 38, join(dir, 'b2.jpg')), 3000, 'stall of B while A sleeps on a flood');
  assert.match(stalledB2.error?.message ?? '', /без новых данных/, 'a flood A waits out does not hide the stall of B');
  assert.ok(Date.now() - started < 1500, `B is cut by its own watchdog: ${Date.now() - started} ms`);
  mode = 'data';
  const finishedA = await settle(pendingA, 5000, 'A after its short flood');
  assert.equal(finishedA.value, join(dir, 'a2.jpg'), String(finishedA.error));
  assert.equal(shared.unhealthy.length, 2, 'only the two stalls of B are marked unhealthy');
  assert.deepEqual(leftovers(), []);

  const fiveParts = sized(5 * PART, 2);
  const slow = await settle(service(async (request) => { await pause(120); return fiveParts(request); })
    .downloadMedia('1', 4, join(dir, 'slow.jpg')), 5000, 'slow download');
  assert.equal(slow.value, join(dir, 'slow.jpg'), String(slow.error));
  assert.equal(statSync(join(dir, 'slow.jpg')).size, 5 * PART);
  delete process.env.TELEGRAM_DOWNLOAD_STALL_MS;

  // Without a path the file lands in the downloads folder and the reply says how to fetch it.
  process.env.TELEGRAM_DOWNLOADS_DIR = join(dir, 'downloads');
  const saved = await service(sized(PART, 3)).downloadMedia('-100123', 5);
  assert.equal(saved, join(dir, 'downloads', 'tg--100123-5.jpg'));
  writeFileSync(saved, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  const tools = {};
  registerMediaTools({ registerTool(name, spec, handler) { tools[name] = { spec, handler }; } }, {
    ensureConnected: async () => true,
    downloadMedia: async (_chat, _message, path) => {
      const target = path ?? saved;
      if (!existsSync(target)) writeFileSync(target, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      return target;
    },
  });
  const tool = tools['telegram-download-media'];
  const explicit = join(dir, 'explicit.jpg');
  assert.deepEqual((await tool.handler({ chatId: '1', messageId: 7, downloadPath: explicit })).content, [{ type: 'text', text: `Media downloaded to ${explicit}` }]);
  assert.match((await tool.handler({ chatId: '1', messageId: 7 })).content[0].text, /^Media downloaded to .*\nРазмер: \d+[^]*ssh \S+ "cat /);
  const inline = await tool.handler({ chatId: '1', messageId: 7, inline: true });
  assert.equal(inline.content[1].type, 'image');
  assert.equal(inline.content[1].mimeType, 'image/jpeg');
  delete process.env.TELEGRAM_DOWNLOADS_DIR;

  // A hung download does not hold the next call of the same client, and a hung read ends at its ceiling.
  process.env.TELEGRAM_READ_TOOL_CEILING_MS = '200';
  const calls = {
    'telegram-download-media': { annotations: { readOnlyHint: true }, handler: () => new Promise(() => {}) },
    'telegram-read-messages': { annotations: { readOnlyHint: true }, handler: async () => 'read' },
    'telegram-get-unread': { annotations: { readOnlyHint: true }, handler: () => new Promise(() => {}) },
    'telegram-send-message': { annotations: { readOnlyHint: false }, handler: async () => { await pause(300); return 'sent'; } },
  };
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    replies: [],
    write(data) { for (const line of String(data).split('\n').filter(Boolean)) this.replies.push(JSON.parse(line)); },
  });
  handleClient(socket, { _registeredTools: calls }, { markUnhealthy() {} }, { toolCallTimeoutMs: 60_000 });
  const reply = (id) => socket.replies.find((message) => message.type === 'tool_response' && message.id === id);
  const send = (id, name) => socket.emit('data', Buffer.from(encodeMessage({ type: 'tool', id, tool: name, args: {} })));
  send('a', 'telegram-download-media');
  send('b', 'telegram-read-messages');
  await pause(50);
  assert.equal(reply('b')?.result, 'read');
  assert.equal(reply('a'), undefined);
  await pause(300);
  assert.match(reply('a')?.error ?? '', /timeout/);
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) send(id, 'telegram-download-media');
  send('r', 'telegram-read-messages');
  await pause(50);
  assert.equal(reply('r')?.result, 'read', 'a fifth download waits for a slot without holding reads');
  await pause(550);
  assert.match(reply('d5')?.error ?? '', /timeout/);
  send('c', 'telegram-get-unread');
  send('d', 'telegram-read-messages');
  await pause(50);
  assert.equal(reply('d'), undefined, 'other calls keep their strict order');
  await pause(300);
  assert.match(reply('c')?.error ?? '', /timeout/);
  assert.equal(reply('d')?.result, 'read');
  send('e', 'telegram-send-message');
  await pause(350);
  assert.equal(reply('e')?.result, 'sent', 'the read ceiling does not cut writes');
  delete process.env.TELEGRAM_READ_TOOL_CEILING_MS;

  const { RateLimiter } = await import(pathToFileURL(resolve(packageDir, 'dist/rate-limiter.js')));
  const flooding = (seconds) => { let calls = 0; return async () => { if (!calls++) throw Object.assign(new Error(`A wait of ${seconds} seconds is required`), { errorMessage: `FLOOD_WAIT_${seconds}`, seconds }); return 'ok'; }; };
  assert.equal(await new RateLimiter().execute(flooding(1), 'probe'), 'ok', 'a short flood is waited out');
  const longFlood = await settle(new RateLimiter().execute(flooding(900), 'probe'), 2000, 'a long flood');
  assert.match(longFlood.error?.message ?? '', /^FLOOD_WAIT_900/);

  console.log('OK: download writer failure, stall watchdog, per-transfer flood mark through FileTransfers, downloads folder, delivery reply, detached queue, read ceiling');
} finally {
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
