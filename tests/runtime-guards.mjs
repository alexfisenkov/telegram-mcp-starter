import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { applyPatches } from '../tools/apply-patches.mjs';

const upstreamPackageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? 'node_modules/@overpod/mcp-telegram');
const packageDir = join(dirname(upstreamPackageDir), `.telegram-mcp-starter-guards-${randomUUID()}`);
assert.equal(existsSync(join(upstreamPackageDir, '.telegram-session')), false, 'upstream package must not contain a Telegram session');
cpSync(upstreamPackageDir, packageDir, { recursive: true, errorOnExist: true, force: false });

try {
  applyPatches(packageDir);
  const requireFromPackage = createRequire(resolve(packageDir, 'package.json'));
  const { Api } = await import(pathToFileURL(requireFromPackage.resolve('telegram/tl/index.js')));
  const { TelegramService } = await import(pathToFileURL(resolve(packageDir, 'dist/telegram-client.js')));
  const { registerMiniAppTools } = await import(pathToFileURL(resolve(packageDir, 'dist/tools/miniapps.js')));

const service = new TelegramService('1', 'invalid-fixture', { sessionPath: join(packageDir, 'no-session') });
let invokeCount = 0;
service.connected = true;
service.resolveChat = async () => ({});
service.resolvePeer = async () => ({ marker: 'unused peer' });
service.client = {
  async getInputEntity() { return Object.create(Api.InputPeerChannel.prototype); },
  async invoke() { invokeCount += 1; },
};
await assert.rejects(service.getForumTopics('@test-channel', 10), /Forum topics are only available in supergroups/);
assert.equal(invokeCount, 0, 'forum-topic type guard rejects before any MTProto invoke');

const handlers = new Map();
let prolongCount = 0;
const fakeTelegram = {
  connected: true,
  async ensureConnected() { return true; },
  async prolongMiniApp() { prolongCount += 1; },
};
registerMiniAppTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) }, fakeTelegram);
const invalidQuery = await handlers.get('telegram-prolong-mini-app').handler({ bot: 'example-bot', queryId: 'not-a-number' });
assert.equal(invalidQuery.isError, true, 'invalid mini-app query ID returns an input error');
assert.equal(prolongCount, 0, 'query-ID validation rejects before calling the Telegram service');

console.log('OK: forum supergroup and mini-app query guards reject before Telegram service calls');
} finally {
  rmSync(packageDir, { recursive: true, force: true });
}
