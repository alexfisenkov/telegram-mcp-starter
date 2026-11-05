import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Import only the installed, manifest-applied runtime. Never construct a live service or client.
const packageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? 'node_modules/@overpod/mcp-telegram');
const requireFromPackage = createRequire(join(packageDir, 'package.json'));
const { Api } = requireFromPackage('telegram/tl/index.js');
const { TelegramService } = await import(pathToFileURL(join(packageDir, 'dist/telegram-client.js')));
const { describeKeyboardButton } = await import(pathToFileURL(join(packageDir, 'dist/telegram-helpers.js')));
const DATA = Buffer.from([0, 255, 64, 97, 10]);
const CHAT = '@synthetic_fixture_bot';
const MESSAGE = 42;
const inline = (type, text = 'Synthetic menu') => new Api.KeyboardInlineButton({ text, type });
const inlineMarkup = (buttons) => new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardInlineButtonRow({ buttons })] });

function fixture(markup) {
  const counts = { reads: 0, invokes: 0, resolves: 0 };
  let request;
  const entity = Object.freeze({ syntheticPeer: true });
  const service = Object.create(TelegramService.prototype);
  service.connected = true;
  service.rateLimiter = { async execute(operation) { return operation(); } };
  service.resolveChat = async (chat) => { counts.resolves += 1; assert.equal(chat, CHAT); return entity; };
  service.client = {
    async getMessages(peer, options) {
      counts.reads += 1; assert.equal(peer, entity); assert.deepEqual(options, { ids: [MESSAGE] });
      return [{ replyMarkup: markup }];
    },
    async invoke(value) {
      counts.invokes += 1; request = value;
      assert.ok(value instanceof Api.messages.GetBotCallbackAnswer);
      assert.equal(value.peer, entity); assert.equal(value.msgId, MESSAGE);
      return { alert: false, hasUrl: false, nativeUi: false, message: 'Synthetic callback answer', cacheTime: 0 };
    }
  };
  return { service, counts, get request() { return request; } };
}

test('teleproto nested callback reader preserves semantic type, label, exact bytes and 2FA flag', async () => {
  assert.equal(requireFromPackage('telegram/package.json').version, '1.229.0');
  const f = fixture(inlineMarkup([
    inline(new Api.InlineButtonTypeCallback({ data: DATA }), 'Synthetic callback'),
    inline(new Api.InlineButtonTypeCallback({ data: DATA, requiresPassword: true }), 'Synthetic 2FA')
  ]));
  const read = await f.service.getMessageButtons(CHAT, MESSAGE);
  assert.deepEqual(read, { markupType: 'ReplyInlineMarkup', buttons: [
    { row: 0, col: 0, type: 'KeyboardButtonCallback', label: 'Synthetic callback', data: 'AP9AYQo=' },
    { row: 0, col: 1, type: 'KeyboardButtonCallback', label: 'Synthetic 2FA', data: 'AP9AYQo=', requiresPassword: true }
  ] });
  assert.equal(f.counts.reads, 1); assert.equal(f.counts.invokes, 0);
});

test('teleproto plain reply and noncallback inline buttons retain their public fields', async () => {
  const plain = new Api.KeyboardButton({ text: 'Synthetic reply', type: new Api.ButtonTypeDefault({}) });
  const reply = fixture(new Api.ReplyKeyboardMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [plain] })] }));
  assert.deepEqual((await reply.service.getMessageButtons(CHAT, MESSAGE)).buttons,
    [{ row: 0, col: 0, type: 'KeyboardButton', label: 'Synthetic reply' }]);
  const examples = [
    [new Api.InlineButtonTypeUrl({ url: 'https://example.invalid/menu' }), 'KeyboardButtonUrl', { url: 'https://example.invalid/menu' }],
    [new Api.InlineButtonTypeUrlAuth({ url: 'https://example.invalid/auth', buttonId: 7 }), 'KeyboardButtonUrlAuth', { url: 'https://example.invalid/auth', buttonId: 7 }],
    [new Api.InlineButtonTypeSwitchInline({ query: 'synthetic', samePeer: true }), 'KeyboardButtonSwitchInline', { switchQuery: 'synthetic', samePeer: true }],
    [new Api.InlineButtonTypeWebView({ url: 'https://example.invalid/app' }), 'KeyboardButtonWebView', { url: 'https://example.invalid/app' }],
    [new Api.InlineButtonTypeUserProfile({ userId: 7n }), 'KeyboardButtonUserProfile', { userId: '7' }],
    [new Api.InlineButtonTypeCopy({ copyText: 'synthetic copy' }), 'KeyboardButtonCopy', { copyText: 'synthetic copy' }],
    [new Api.ButtonTypeRequestPoll({ quiz: true }), 'KeyboardButtonRequestPoll', { quiz: true }],
    [new Api.ButtonTypeRequestPeer({ buttonId: 8, maxQuantity: 1, peerType: {} }), 'KeyboardButtonRequestPeer', { buttonId: 8 }],
    [new Api.ButtonTypeSimpleWebView({ url: 'https://example.invalid/simple' }), 'KeyboardButtonSimpleWebView', { url: 'https://example.invalid/simple' }]
  ];
  for (const [payload, type, fields] of examples) {
    const button = payload.className.startsWith('ButtonType') ? new Api.KeyboardButton({ text: 'Synthetic field', type: payload }) : inline(payload, 'Synthetic field');
    assert.deepEqual(describeKeyboardButton(button, 1, 2), { row: 1, col: 2, type, label: 'Synthetic field', ...fields });
  }
  assert.equal(reply.counts.invokes, 0);
});

test('row-column pressing uses the same nested callback payload in one exact RPC', async () => {
  const f = fixture(inlineMarkup([inline(new Api.InlineButtonTypeCallback({ data: DATA }))]));
  const answer = await f.service.pressButton(CHAT, MESSAGE, { buttonIndex: { row: 0, column: 0 } });
  assert.equal(answer.message, 'Synthetic callback answer');
  assert.deepEqual(f.request.data, DATA);
  assert.deepEqual(f.counts, { reads: 1, invokes: 1, resolves: 1 });
});

test('2FA and noncallback button types are refused before any callback RPC', async () => {
  const password = fixture(inlineMarkup([inline(new Api.InlineButtonTypeCallback({ data: DATA, requiresPassword: true }))]));
  await assert.rejects(password.service.pressButton(CHAT, MESSAGE, { buttonIndex: { row: 0, column: 0 } }), /requires 2FA/u);
  assert.equal(password.counts.invokes, 0);
  for (const payload of [
    new Api.InlineButtonTypeUrl({ url: 'https://example.invalid/' }),
    new Api.InlineButtonTypeUrlAuth({ url: 'https://example.invalid/', buttonId: 1 }),
    new Api.InlineButtonTypeGame({}), new Api.InlineButtonTypeBuy({}),
    new Api.InlineButtonTypeSwitchInline({ query: 'synthetic' }),
    new Api.InlineButtonTypeWebView({ url: 'https://example.invalid/' }),
    new Api.InlineButtonTypeDisabled({}), new Api.InlineButtonTypeCopy({ copyText: 'synthetic' }),
    new Api.InlineButtonTypeUserProfile({ userId: 9n })
  ]) {
    const f = fixture(inlineMarkup([inline(payload)]));
    await assert.rejects(f.service.pressButton(CHAT, MESSAGE, { buttonIndex: { row: 0, column: 0 } }), /not callable|telegram-open-mini-app/u);
    assert.equal(f.counts.reads, 1); assert.equal(f.counts.invokes, 0, payload.className);
  }
});

test('explicit observed base64 data path retains its existing no-message-read behavior', async () => {
  const f = fixture(undefined);
  await f.service.pressButton(CHAT, MESSAGE, { data: 'AP9AYQo=' });
  assert.deepEqual(f.request.data, DATA);
  assert.deepEqual(f.counts, { reads: 0, invokes: 1, resolves: 1 });
});

test('legacy GramJS constructors remain usable alongside teleproto and preserve old fields', async () => {
  const names = ['KeyboardButtonCallback', 'KeyboardButtonUrl', 'KeyboardButtonWebView'];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(Api, name)]);
  try {
    for (const name of names) {
      Api[name] = class { constructor(fields) { Object.assign(this, fields); this.className = name; } };
    }
    const legacy = new Api.KeyboardButtonCallback({ text: 'Legacy callback', data: DATA });
    assert.deepEqual(describeKeyboardButton(legacy, 0, 0),
      { row: 0, col: 0, type: 'KeyboardButtonCallback', label: 'Legacy callback', data: 'AP9AYQo=' });
    const f = fixture(inlineMarkup([legacy]));
    await f.service.pressButton(CHAT, MESSAGE, { buttonIndex: { row: 0, column: 0 } });
    assert.deepEqual(f.request.data, DATA); assert.equal(f.counts.invokes, 1);
    assert.equal(describeKeyboardButton(new Api.KeyboardButtonUrl({ text: 'Legacy URL', url: 'https://example.invalid/' }), 0, 1).url,
      'https://example.invalid/');
    const protectedButton = new Api.KeyboardButtonCallback({ text: 'Legacy 2FA', data: DATA, requiresPassword: true });
    const protectedFixture = fixture(inlineMarkup([protectedButton]));
    await assert.rejects(protectedFixture.service.pressButton(CHAT, MESSAGE, { buttonIndex: { row: 0, column: 0 } }), /requires 2FA/u);
    assert.equal(protectedFixture.counts.invokes, 0);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Api, name, descriptor); else delete Api[name];
    }
  }
});
