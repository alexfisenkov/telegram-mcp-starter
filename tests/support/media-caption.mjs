import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = resolve(process.argv[2] ?? join(repo, "node_modules/@overpod/mcp-telegram"));
const req = createRequire(join(pkg, "package.json"));
const { Api } = req("telegram/tl/index.js");
const { TelegramClient } = req("telegram");
const { TelegramService } = await import(pathToFileURL(join(pkg, "dist/telegram-client.js")));
const { registerMediaTools } = await import(pathToFileURL(join(pkg, "dist/tools/media.js")));
const tools = {};
registerMediaTools({ registerTool(name, spec, handler) { tools[name] = { spec, handler }; } }, {});
assert.ok(tools["telegram-send-file"].spec.inputSchema.parseMode, "send-file accepts formatting mode");
assert.ok(tools["telegram-prepare-media-caption"], "caption preflight is available read-only");
assert.ok(tools["telegram-edit-media-caption"], "caption-only recovery tool is available");
const s = Object.create(TelegramService.prototype);
s.connected = true;
s.uploadsInFlight = new Set();
s.resolvePeer = async x => x;
let sent = [], edits = [], premium = true, configAvailable = true, removeAfterSend = false;
const cfg = () => new Api.JsonObject({ value: [
  new Api.JsonObjectValue({ key: "caption_length_limit_default", value: new Api.JsonNumber({ value: 12 }) }),
  new Api.JsonObjectValue({ key: "caption_length_limit_premium", value: new Api.JsonNumber({ value: 4096 }) }),
] });
s.client = Object.assign(Object.create(TelegramClient.prototype), {
  async getMe() { return { id: 7n, premium }; },
  async invoke(q) { assert.ok(q instanceof Api.help.GetAppConfig); if (!configAvailable) throw Error("config unavailable"); return { config: cfg() }; },
  async getInputEntity(x) { return new Api.InputPeerSelf({}); },
  async sendFile(peer, opts) { sent.push(opts); if (removeAfterSend) rmSync(opts.file); return { id: 42 }; },
  async getMessages(peer, opts) { return [{ id: opts.ids[0], out: true, media: new Api.MessageMediaDocument({ document: new Api.DocumentEmpty({ id: 1n }) }) }]; },
  async editMessage(peer, opts) { edits.push(opts); return { id: opts.message }; },
});
const input = '<b>🎬 Тест</b> <a href="https://example.com/video">видео</a>\n00:00 — Старт\n<a href="https://example.com/notes">выводы</a>';
const p = await s.prepareMediaCaption(input, "html");
assert.equal(p.text, "🎬 Тест видео\n00:00 — Старт\nвыводы");
assert.equal(p.entities.filter(e => e.className === "MessageEntityTextUrl").length, 2);
assert.equal(p.entities[1].offset, 8, "emoji offsets use UTF16");
s.ensureConnected = async () => true;
const jsonTools = {};
registerMediaTools({ registerTool(name, spec, handler) { jsonTools[name] = handler; } }, s);
const jsonResult = await jsonTools["telegram-prepare-media-caption"]({caption:input,parseMode:"html"});
assert.ok(!jsonResult.isError);
const jsonPrepared = JSON.parse(jsonResult.content[0].text);
assert.deepEqual(jsonPrepared.entities, [
 {className:"MessageEntityBold",offset:0,length:7},
 {className:"MessageEntityTextUrl",offset:8,length:5,url:"https://example.com/video"},
 {className:"MessageEntityTextUrl",offset:28,length:6,url:"https://example.com/notes"},
], "MCP handler JSON preserves actual UTF16 offsets/lengths for emoji/Cyrillic and both links");
assert.equal(p.utf8Bytes, Buffer.byteLength(p.text));
assert.equal(p.limit, 4096);
assert.equal((await s.prepareMediaCaption("я".repeat(3000))).codepoints, 3000, "UTF8 bytes do not reject valid Cyrillic captions");
const dir = mkdtempSync(join(tmpdir(), "caption-m20-"));
try {
 const file = join(dir, "synthetic.txt"); writeFileSync(file, "test");
 await s.sendFile("me", file, input, undefined, true, 9, 8, "html");
 assert.equal(sent[0].caption, p.text); assert.equal(sent[0].formattingEntities.length, p.entities.length);
 assert.equal(sent[0].parseMode, false); assert.equal(sent[0].replyTo, 9); assert.equal(sent[0].topMsgId, 8);
 await s.sendFile("me", file, "<b>literal</b>");
 assert.equal(sent[1].caption, "<b>literal</b>"); assert.equal(sent[1].formattingEntities, undefined);
 await assert.rejects(s.sendFile("me", file, "я".repeat(4097), undefined, false, undefined, undefined, "html"), /CAPTION_TOO_LONG/);
 assert.equal(sent.length, 2, "overlong caption fails before upload");
 const md = await s.prepareMediaCaption("**bold**", "md"); assert.equal(md.text, "bold");
 premium = false;
 await assert.rejects(s.prepareMediaCaption("я".repeat(13)), /CAPTION_TOO_LONG/);
 premium = true; configAvailable = false;
 await assert.rejects(s.sendFile("me", file, "<b>ok</b>", undefined, false, undefined, undefined, "html"), /config unavailable/);
 assert.equal(sent.length, 2, "missing config fails before formatted upload");
 await s.sendFile("me", file, "<b>literal config offline</b>");
 await s.sendFile("me", file);
 assert.equal(sent.length, 4, "plain and empty captions retain availability without app config");
 assert.equal(sent[2].caption, "<b>literal config offline</b>");
 assert.equal(sent[2].formattingEntities, undefined);
 assert.equal(sent[3].caption, undefined);
 configAvailable = true;
 await s.editMediaCaption("me", 42, input, "html");
 assert.equal(edits[0].text, p.text); assert.equal(edits[0].formattingEntities.length, p.entities.length);
 assert.equal(edits[0].file, undefined); assert.equal(edits[0].parseMode, false);
 const oldGet = s.client.getMessages;
 s.client.getMessages = async () => [{ out: false, media: {} }];
 await assert.rejects(s.editMediaCaption("me", 42, "x"), /own media/);
 s.client.getMessages = async () => [{ out: true }];
 await assert.rejects(s.editMediaCaption("me", 42, "x"), /own media/);
 const saved = (fields = {}) => ({ id: 42, out: false, senderId: 7n, peerId: new Api.PeerUser({ userId: 7n }), fromId: new Api.PeerUser({ userId: 7n }), media: new Api.MessageMediaDocument({ document: new Api.DocumentEmpty({ id: 1n }) }), ...fields });
 s.client.getMessages = async () => [saved()];
 await s.editMediaCaption("me", 42, input, "html");
 assert.equal(edits.length, 2, "Saved Messages own sender is editable without out flag");
 for (const fromId of [null, undefined]) {
   s.client.getMessages = async () => [saved({fromId})];
   await s.editMediaCaption("me", 42, input, "html");
 }
 assert.equal(edits.length, 4, "native-like own Saved media with absent fromId is editable only in self peer");
 s.client.getMessages = async () => [saved({ fromId: new Api.PeerUser({ userId: 8n }), senderId: 8n })];
 await assert.rejects(s.editMediaCaption("me", 42, "x"), /own media/);
 const oldInput = s.client.getInputEntity;
 s.client.getInputEntity = async () => new Api.InputPeerUser({ userId: 8n, accessHash: 1n });
 s.client.getMessages = async () => [saved()];
 await assert.rejects(s.editMediaCaption("other", 42, "x"), /own media/);
 s.client.getInputEntity = oldInput;
 for (const fields of [{peerId:new Api.PeerUser({userId:8n})}, {peerId:new Api.PeerChannel({channelId:7n})}, {fromId:new Api.PeerUser({userId:8n})}, {senderId:8n}, {senderId:undefined}, {fromId:null,senderId:8n}, {fromId:null,senderId:undefined}, {fromId:undefined,senderId:undefined}, {fwdFrom:{}}, {post:true}, {media:undefined}]) {
   s.client.getMessages = async () => [saved(fields)];
   await assert.rejects(s.editMediaCaption("me", 42, "x"), /own media/);
 }
 // Native readback metadata is exact and bounded: no accessHash/fileReference leak.
 s.client.getMessages = async () => [saved()];
 s.fisRichFieldsFull = async () => ({text:"synthetic"});
 s.resolveSenderName = async () => "synthetic";
 const native = (await s.getMessages("me", 1, 43))[0].native;
 assert.deepEqual(native, {out:false,peerId:{type:"PeerUser",id:"7"},fromId:{type:"PeerUser",id:"7"},hasDirectDocument:false,hasMediaDocument:true,hasPhoto:false,documentId:"1"});
 assert.ok(!JSON.stringify(native).includes("accessHash") && !JSON.stringify(native).includes("fileReference"));
 s.client.getMessages = oldGet;
 await assert.rejects(s.prepareMediaCaption("x", "bad"), /parseMode/);
 assert.equal(edits.length, 4);
 // Exercise the actual MP4 branch, with a deterministic ffprobe executable fixture.
 const videoFile = join(dir, "synthetic.mp4"); writeFileSync(videoFile, "mock video bytes");
 const probe = join(dir, "ffprobe-fixture");
 writeFileSync(probe, '#!/usr/bin/env node\nconsole.log(JSON.stringify({streams:[{width:1920,height:1118}],format:{duration:"4.2"}}));\n');
 chmodSync(probe, 0o755);
 const previousProbe = process.env.FFPROBE_PATH;
 try {
   process.env.FFPROBE_PATH = probe;
   const before = sent.length;
   const result = await s.sendFile("me", videoFile, input, undefined, false, undefined, undefined, "html");
   const opts = sent[before];
   assert.equal(opts.forceDocument, undefined);
   assert.equal(opts.caption, p.text);
   assert.equal(opts.formattingEntities.length, p.entities.length);
   assert.ok(opts.attributes[0] instanceof Api.DocumentAttributeVideo);
   assert.equal(opts.attributes[0].w, 1920); assert.equal(opts.attributes[0].h, 1118);
   assert.equal(opts.attributes[0].duration, 5); assert.equal(opts.attributes[0].supportsStreaming, true);
   assert.equal(opts.supportsStreaming, true); assert.equal(opts.workers, 4);
   assert.equal(result.type, "video"); assert.equal(result.messageId, 42);
   assert.equal(result.width, 1920); assert.equal(result.height, 1118); assert.equal(result.duration, 5);
 } finally { if (previousProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousProbe; }
 const disappearing = join(dir, "removed-after-send.txt"); writeFileSync(disappearing, "snapshot size");
 const expectedSize = statSync(disappearing).size;
 removeAfterSend = true;
 const ack = await s.sendFile("me", disappearing, "plain");
 assert.equal(ack.messageId, 42, "accepted message keeps its ID even when source disappears after send");
 assert.equal(ack.size, expectedSize, "return the size snapshot taken before upload");
 removeAfterSend = false;
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("PASS: media caption schema, real parsers/entities, UTF16 offsets, live-config limits before upload, plain compatibility, caption-only own-media edit");
