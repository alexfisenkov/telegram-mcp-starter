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

  const service = (getFile) => {
    const client = { session: { dcId: 2 }, _media: { getFile, opts: { partSize: PART } } };
    const location = new Api.InputDocumentFileLocation({ id: bigInt(1), accessHash: bigInt(1), fileReference: Buffer.alloc(0), thumbSize: '' });
    const instance = Object.create(TelegramService.prototype);
    instance.connected = true;
    instance.unhealthy = [];
    instance.markUnhealthy = (reason) => instance.unhealthy.push(reason);
    instance.resolvePeer = async () => ({});
    instance.client = {
      getMessages: async () => [{ media: {}, photo: {} }],
      downloadMedia: (_message, { outputFile, progressCallback, signal }) => downloadFile(client, location, { outputFile, progressCallback, signal }),
    };
    return instance;
  };
  const leftovers = () => readdirSync(dir).filter((name) => name.endsWith('.part'));

  // A path the server cannot write answers with words and never asks Telegram for the file.
  let requests = 0;
  const unwritable = await settle(service(async () => { requests += 1; return Buffer.alloc(0); })
    .downloadMedia('1', 1, join(dir, 'missing-folder', 'x.jpg')), 3000, 'write to a missing folder');
  assert.match(unwritable.error?.message ?? '', /ENOENT/);
  assert.match(unwritable.error.message, /downloadPath/);
  assert.equal(requests, 0);

  // A stream that dies mid-download ends the call instead of hanging it.
  const breaking = service(async () => { await pause(5); return Buffer.alloc(PART, 1); });
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
  let parts = 0;
  const slow = await settle(service(async () => { await pause(120); return parts++ < 5 ? Buffer.alloc(PART, 2) : Buffer.alloc(0); })
    .downloadMedia('1', 4, join(dir, 'slow.jpg')), 5000, 'slow download');
  assert.equal(slow.value, join(dir, 'slow.jpg'), String(slow.error));
  assert.equal(statSync(join(dir, 'slow.jpg')).size, 5 * PART);
  delete process.env.TELEGRAM_DOWNLOAD_STALL_MS;

  // Without a path the file lands in the downloads folder and the reply says how to fetch it.
  process.env.TELEGRAM_DOWNLOADS_DIR = join(dir, 'downloads');
  let chunks = 0;
  const saved = await service(async () => (chunks++ < 1 ? Buffer.alloc(PART, 3) : Buffer.alloc(0))).downloadMedia('-100123', 5);
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

  console.log('OK: download writer failure, stall watchdog, downloads folder, delivery reply, detached queue, read ceiling');
} finally {
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
