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
const CHAT = '@synthetic_fixture_forum';
const USER = '@synthetic_fixture_user';
const TOPIC = 7;

function fixture({ forum = true, reply } = {}) {
  const calls = { invokes: [], resolvePeer: 0, inputEntity: 0 };
  const channel = new Api.Channel({ id: 1n, title: 'Synthetic forum', forum, megagroup: true });
  const inputPeer = Object.freeze({ syntheticInputPeer: true });
  const resolvedPeer = Object.freeze({ syntheticResolvedPeer: true });
  const service = Object.create(TelegramService.prototype);
  service.connected = true;
  service.rateLimiter = { async execute(operation) { return operation(); } };
  service.resolveChat = async (chat) => { assert.equal(chat, CHAT); return channel; };
  service.resolvePeer = async (chat) => { calls.resolvePeer += 1; assert.equal(chat, CHAT); return resolvedPeer; };
  service.client = {
    async getInputEntity(value) { calls.inputEntity += 1; assert.equal(value, resolvedPeer); return inputPeer; },
    async getEntity(value) { assert.equal(value, USER); return new Api.User({ id: 2n, accessHash: 3n, firstName: 'Synthetic' }); },
    async invoke(request) { calls.invokes.push(request); return reply ? reply(request) : true; }
  };
  return { service, calls, channel, inputPeer };
}

function assertMessagesRequest(request, className, inputPeer) {
  assert.equal(request.className, className);
  assert.ok(request instanceof Api.messages[className.split('.')[1]], `${className} is a messages.* request`);
  assert.equal(request.peer, inputPeer, `${className} carries the resolved InputPeer`);
  assert.equal(request.channel, undefined, `${className} has no legacy channel field`);
}

test('pinned teleproto schema has forum topic requests only under messages.*', () => {
  assert.equal(requireFromPackage('telegram/package.json').version, '1.233.0');
  for (const name of ['CreateForumTopic', 'EditForumTopic', 'UpdatePinnedForumTopic', 'ReorderPinnedForumTopics', 'DeleteTopicHistory']) {
    assert.equal(typeof Api.messages[name], 'function', `messages.${name} exists`);
    assert.equal(Api.channels[name], undefined, `channels.${name} is absent in the pinned schema`);
  }
});

test('createForumTopic sends messages.CreateForumTopic with peer and reads the new topic id', async () => {
  const f = fixture({
    reply: (request) => new Api.Updates({
      updates: [new Api.UpdateMessageID({ id: 55, randomId: request.randomId })],
      users: [], chats: [], date: 0, seq: 0
    })
  });
  const result = await f.service.createForumTopic(CHAT, 'Synthetic topic', 0x6fb9f0, undefined);
  assert.deepEqual(result, { id: 55, title: 'Synthetic topic' });
  assert.equal(f.calls.invokes.length, 1);
  assertMessagesRequest(f.calls.invokes[0], 'messages.CreateForumTopic', f.inputPeer);
  assert.equal(f.calls.invokes[0].title, 'Synthetic topic');
});

test('edit, pin, reorder and delete send messages.* requests with peer', async () => {
  const f = fixture();
  await f.service.editForumTopic(CHAT, TOPIC, { title: 'Renamed', closed: true });
  await f.service.pinForumTopic(CHAT, TOPIC, true);
  await f.service.reorderPinnedForumTopics(CHAT, [TOPIC, 9], true);
  await f.service.deleteForumTopic(CHAT, TOPIC);
  const [edit, pin, reorder, del] = f.calls.invokes;
  assertMessagesRequest(edit, 'messages.EditForumTopic', f.inputPeer);
  assert.equal(edit.topicId, TOPIC); assert.equal(edit.title, 'Renamed'); assert.equal(edit.closed, true);
  assertMessagesRequest(pin, 'messages.UpdatePinnedForumTopic', f.inputPeer);
  assert.equal(pin.topicId, TOPIC); assert.equal(pin.pinned, true);
  assertMessagesRequest(reorder, 'messages.ReorderPinnedForumTopics', f.inputPeer);
  assert.deepEqual(reorder.order, [TOPIC, 9]); assert.equal(reorder.force, true);
  assertMessagesRequest(del, 'messages.DeleteTopicHistory', f.inputPeer);
  assert.equal(del.topMsgId, TOPIC);
  assert.equal(f.calls.resolvePeer, 4); assert.equal(f.calls.inputEntity, 4);
});

test('forum topic calls on a non-forum chat are refused before any RPC', async () => {
  const f = fixture({ forum: false });
  await assert.rejects(f.service.pinForumTopic(CHAT, TOPIC), /only available in forum supergroups/u);
  await assert.rejects(f.service.deleteForumTopic(CHAT, TOPIC), /only available in forum supergroups/u);
  assert.equal(f.calls.invokes.length, 0);
});

test('setAdmin grants topic and story management but never addAdmins or anonymous', async () => {
  const f = fixture();
  await f.service.setAdmin(CHAT, USER, { title: 'Synthetic rank' });
  assert.equal(f.calls.invokes.length, 1);
  const [request] = f.calls.invokes;
  assert.ok(request instanceof Api.channels.EditAdmin);
  assert.equal(request.channel, f.channel); assert.equal(request.rank, 'Synthetic rank');
  const rights = request.adminRights;
  assert.ok(rights instanceof Api.ChatAdminRights);
  for (const field of ['changeInfo', 'postMessages', 'editMessages', 'deleteMessages', 'banUsers', 'inviteUsers',
    'pinMessages', 'manageCall', 'manageTopics', 'postStories', 'editStories', 'deleteStories']) {
    assert.equal(rights[field], true, `${field} is granted`);
  }
  for (const field of ['addAdmins', 'anonymous']) assert.notEqual(rights[field], true, `${field} is not granted`);
});
