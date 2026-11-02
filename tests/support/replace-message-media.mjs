import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = resolve(process.argv[2] ?? join(repo, 'node_modules/@overpod/mcp-telegram'));
const req = createRequire(join(pkg, 'package.json'));
const { Api } = req('telegram/tl/index.js');
const { TelegramClient } = req('telegram');
const { TelegramService } = await import(pathToFileURL(join(pkg, 'dist/telegram-client.js')));
const { registerMediaTools } = await import(pathToFileURL(join(pkg, 'dist/tools/media.js')));
const tools = {};
registerMediaTools({registerTool(name, spec, handler) { tools[name] = {spec, handler}; }}, {});
assert.ok(tools['telegram-replace-message-media'], 'same-message replacement tool registered');
const spec = tools['telegram-replace-message-media'].spec;
assert.equal(spec.inputSchema.dryRun.parse(undefined), true);
const dir = mkdtempSync(join(tmpdir(), 'replace-m21-'));
const previousProbe = process.env.FFPROBE_PATH;
try {
 const file = join(dir, 'synthetic.mp4'); writeFileSync(file, 'mock video bytes');
 const probe = join(dir, 'ffprobe');
 writeFileSync(probe, '#!/usr/bin/env node\nconsole.log(JSON.stringify({streams:[{width:1920,height:1118}],format:{duration:"4.2",format_name:process.env.M21_FIXTURE_FORMAT || "mov,mp4,m4a,3gp,3g2,mj2"}}));\n');
 chmodSync(probe, 0o755); process.env.FFPROBE_PATH = probe;
 const oldDoc = new Api.Document({id:1n,accessHash:2n,fileReference:Buffer.alloc(0),date:1,mimeType:'video/mp4',size:BigInt(statSync(file).size),dcId:1,attributes:[new Api.DocumentAttributeVideo({duration:4,w:1280,h:720,supportsStreaming:true})]});
 const entities = [new Api.MessageEntityBold({offset:0,length:7}), new Api.MessageEntityTextUrl({offset:8,length:5,url:'https://example.com/video'})];
 let current = {id:42,date:Math.floor(Date.now()/1000),out:true,peerId:new Api.PeerChannel({channelId:9n}),fromId:new Api.PeerUser({userId:7n}),message:'🎬 Тест видео',entities,media:new Api.MessageMediaDocument({document:oldDoc})};
 let uploads = 0, edits = 0, uploaded, request, afterUpload, invokeError, readbackError, uploadParts = 8000, premium = true;
 const service = Object.create(TelegramService.prototype);
 service.connected = true; service.uploadsInFlight = new Set(); service.resolvePeer = async x => x;
 service.client = Object.assign(Object.create(TelegramClient.prototype), {
  async getMe() {return {id:7n,premium};},
  async getInputEntity() {return new Api.InputPeerChannel({channelId:9n,accessHash:1n});},
  async getEntity() {return new Api.Channel({id:9n,title:'synthetic',megagroup:true,creator:true,date:1,photo:new Api.ChatPhotoEmpty({})});},
  async getParticipant() {return {participant:new Api.ChannelParticipantCreator({userId:7n,adminRights:new Api.ChatAdminRights({})})};},
  async getMessages() {if (readbackError && edits >= readbackError) throw Error('offline'); return [current];},
  async uploadFile(opts) {uploads++; uploaded=opts; if (afterUpload) await afterUpload(); opts.onProgress?.(0.5); return new Api.InputFileBig({id:4n,parts:1,name:'synthetic.mp4'});},
  async invoke(q) {
   if (q instanceof Api.help.GetAppConfig) return {config:new Api.JsonObject({value:[new Api.JsonObjectValue({key:'caption_length_limit_premium',value:new Api.JsonNumber({value:4096})}),new Api.JsonObjectValue({key:premium?'upload_max_fileparts_premium':'upload_max_fileparts_default',value:new Api.JsonNumber({value:uploadParts})}),new Api.JsonObjectValue({key:'caption_length_limit_default',value:new Api.JsonNumber({value:1024})})]})};
   if (q instanceof Api.help.GetConfig) return {editTimeLimit:172800};
   assert.ok(q instanceof Api.messages.EditMessage); assert.equal(this._requestRetries,1); assert.equal(this._floodSleepThreshold,0); edits++; request=q; if(invokeError) throw invokeError;
   current={...current,message:q.message,entities:q.entities,media:new Api.MessageMediaDocument({document:new Api.Document({id:3n,accessHash:2n,fileReference:Buffer.alloc(0),date:1,mimeType:'video/mp4',size:BigInt(statSync(file).size),dcId:1,attributes:q.media.attributes})})};
   return {};
  },
  sendFile() {assert.fail('replacement must never send a new message');},
  deleteMessages() {assert.fail('replacement must never delete the existing message');},
 });
 const input = {chatId:'-1009',messageId:42,filePath:file,expectedAccountId:'7'};
 const preview = await service.replaceMessageMedia(input);
 assert.equal(preview.dryRun,true); assert.equal(uploads,0); assert.equal(edits,0);
 assert.equal(preview.baseline.documentId,'1'); assert.equal(preview.baseline.peerKey,'channel:9');
 assert.equal(preview.video.width,1920); assert.equal(preview.captionPreserved,true);
 const apply = {...input,dryRun:false,expectedPeerKey:preview.baseline.peerKey,expectedDocumentId:'1',expectedCaptionSha256:preview.baseline.captionSha256,expectedSourceSha256:preview.sourceSha256};
 for (const bad of [{expectedAccountId:'8'},{expectedDocumentId:'2'},{expectedPeerKey:'channel:10'},{expectedCaptionSha256:'0'.repeat(64)},{expectedSourceSha256:undefined},{expectedSourceSha256:'0'.repeat(64)},{expectedDocumentId:undefined},{filePath:'https://example.com/x.mp4'},{filePath:'/proc/self/environ'}]) {
  await assert.rejects(service.replaceMessageMedia({...apply,...bad}));
 }
 const original=current;
 const initialPeer=service.client.getInputEntity;
 service.client.getInputEntity=async()=>new Api.InputPeerSelf({});
 current={...original,out:false,fromId:null,senderId:7n,peerId:new Api.PeerUser({userId:7n})};
 const savedPreview=await service.replaceMessageMedia({...input,chatId:'me'});
 assert.equal(savedPreview.baseline.peerKey,'user:7'); assert.equal(savedPreview.editWindow.savedDialog,true);
 current={...current,senderId:8n}; await assert.rejects(service.replaceMessageMedia({...input,chatId:'me'}));
 service.client.getInputEntity=initialPeer; current=original;
 for (const bad of [{out:false},{fromId:new Api.PeerUser({userId:8n})},{groupedId:5n},{fwdFrom:{}},{media:undefined},{peerId:new Api.PeerChannel({channelId:10n})}]) {
  current={...original,...bad}; await assert.rejects(service.replaceMessageMedia(apply));
 }
 current=original;
 const getEntity=service.client.getEntity;
 service.client.getEntity=async()=>({megagroup:true,left:true});
 await assert.rejects(service.replaceMessageMedia(apply)); service.client.getEntity=getEntity;
 const participant=service.client.getParticipant;
 service.client.getEntity=async()=>({megagroup:true});
 service.client.getParticipant=async()=>({participant:new Api.ChannelParticipantSelf({userId:7n,date:1,inviterId:7n})});
 current={...original,date:Math.floor(Date.now()/1000)-172801};
 await assert.rejects(service.replaceMessageMedia(apply),/EDIT_EXPIRED/);
 current=original;service.client.getParticipant=participant;service.client.getEntity=getEntity;
 const link=join(dir,'link.mp4'); symlinkSync(file,link);
 await assert.rejects(service.replaceMessageMedia({...apply,filePath:link}));
 const tooBig=join(dir,'too-big.mp4');writeFileSync(tooBig,Buffer.alloc(524289));
 premium=false;uploadParts=1;await assert.rejects(service.replaceMessageMedia({...input,filePath:tooBig}),/FILE_TOO_LARGE/);
 uploadParts=undefined;await assert.rejects(service.replaceMessageMedia(input),/LIMITS/);
 premium=true;uploadParts=8000;
 const savedSource = 'mock video bytes';writeFileSync(file,'another valid MP4 source');
 await assert.rejects(service.replaceMessageMedia(apply),/SOURCE_CONFLICT/);writeFileSync(file,savedSource);
 process.env.M21_FIXTURE_FORMAT='matroska,webm';
 await assert.rejects(service.replaceMessageMedia(input),/MP4-family/);delete process.env.M21_FIXTURE_FORMAT;
 assert.equal(uploads,0,'identity, CAS, own message, rights, live limit, source SHA, container and paths fail before upload');
 await assert.rejects(service.replaceMessageMedia(apply,(n)=>{if(n===0)current={...current,message:'changed while hashing'};}),/CONFLICT/);
 assert.equal(uploads,0,'hash-time target mutation is caught under lock before upload');current=original;
 afterUpload=()=>{current={...current,message:'changed externally'};};
 await assert.rejects(service.replaceMessageMedia(apply), /CONFLICT/);
 assert.equal(uploads,1); assert.equal(edits,0,'second CAS prevents edit after a racing caption mutation');
 current=original; afterUpload=undefined;
 let progress;
 const result=await service.replaceMessageMedia(apply,(n,total)=>{progress=[n,total];});
 assert.equal(uploads,2); assert.equal(edits,1); assert.equal(result.status,'verified'); assert.equal(result.messageId,42);
 assert.equal(request.id,42); assert.equal(request.message,original.message); assert.equal(request.entities,entities);
 assert.ok(request.media instanceof Api.InputMediaUploadedDocument);
 const attr=request.media.attributes.find(x=>x instanceof Api.DocumentAttributeVideo);
 assert.equal(attr.w,1920);assert.equal(attr.h,1118);assert.equal(attr.duration,5);assert.equal(attr.supportsStreaming,true);
 assert.equal(uploaded.file.size,statSync(file).size); assert.equal(uploaded.workers,4); assert.deepEqual(progress,[0.5,1]);
 assert.equal(result.baseline.captionSha256,preview.baseline.captionSha256);
 const next={...apply,expectedDocumentId:'3'};
 readbackError=2;
 const unknown=await service.replaceMessageMedia(next);
 assert.equal(unknown.status,'outcome_unknown');assert.equal(unknown.retryAllowed,false);assert.equal(edits,2);
 readbackError=false; current={...original,media:current.media}; invokeError=Error('connection lost');
 const lost=await service.replaceMessageMedia(next);
 assert.equal(lost.status,'outcome_unknown');assert.equal(edits,3);assert.equal(uploads,4);
 invokeError=undefined;
 // Concurrent aliases/paths for the same target are excluded until reconciliation.
 current=original;let releaseUpload;const held=new Promise(resolve=>{releaseUpload=resolve;});
 afterUpload=()=>held;
 const running=service.replaceMessageMedia(apply);
 while(uploads<5) await new Promise(resolve=>setTimeout(resolve,1));
 await assert.rejects(service.replaceMessageMedia(apply),/IN_PROGRESS/);
 releaseUpload();await running;afterUpload=undefined;current=original;
 // "me" and numeric self aliases resolve to one lock and one CAS key.
 const previousPeer=service.client.getInputEntity;
 service.client.getInputEntity=async x=>x==='me'?new Api.InputPeerSelf({}):new Api.InputPeerUser({userId:7n,accessHash:1n});
 current={...original,out:false,fromId:null,senderId:7n,peerId:new Api.PeerUser({userId:7n})};
 const savedBaseline=await service.replaceMessageMedia({...input,chatId:'me'});
 let releaseSaved;const heldSaved=new Promise(resolve=>{releaseSaved=resolve;});afterUpload=()=>heldSaved;
 const savedApply={...apply,chatId:'me',expectedPeerKey:savedBaseline.baseline.peerKey};
 const previousUploads=uploads;const savedRunning=service.replaceMessageMedia(savedApply);
 while(uploads===previousUploads) await new Promise(resolve=>setTimeout(resolve,1));
 await assert.rejects(service.replaceMessageMedia({...savedApply,chatId:'7'}),/IN_PROGRESS/);
 releaseSaved();await savedRunning;afterUpload=undefined;service.client.getInputEntity=previousPeer;current=original;
 // A local source mutation after upload is rejected before EditMessage.
 const previousEdits=edits;afterUpload=()=>writeFileSync(file,'changed video source');
 await assert.rejects(service.replaceMessageMedia(apply),/SOURCE_CHANGED/);assert.equal(edits,previousEdits);
 writeFileSync(file,'mock video bytes');afterUpload=undefined;current=original;
 // Explicit HTML caption replacement still uses real parser, live limit and UTF16 entities.
 current=original;
 const replacement=await service.replaceMessageMedia({...input,caption:'<b>Тест</b> <a href="https://example.com/notes">выводы</a>',parseMode:'html'});
 assert.equal(replacement.captionPreserved,false);
 assert.notEqual(replacement.plannedCaptionSha256,preview.baseline.captionSha256);
 const formatted=await service.replaceMessageMedia({...apply,caption:'<b>Тест</b> <a href="https://example.com/notes">выводы</a>',parseMode:'html'});
 assert.equal(formatted.status,'verified');assert.equal(request.message,'Тест выводы');assert.equal(request.entities[1].url,'https://example.com/notes');
 current=original;
 await assert.rejects(service.replaceMessageMedia({...input,caption:'я'.repeat(4097)}),/CAPTION_TOO_LONG/);
 // Tool handler uses the same owner service and forwards progress; no second client/session.
 service.ensureConnected=async()=>true;
 const handlers={}; registerMediaTools({registerTool(n,s,h){handlers[n]=h;}},service);
 const json=await handlers['telegram-replace-message-media'](input);
 assert.equal(JSON.parse(json.content[0].text).dryRun,true);
 // Verify pinned teleproto invoke observes local facade controls and queues once on FLOOD_WAIT.
 const {invoke:pinnedInvoke}=req('telegram/client/users.js');
 const {FloodWaitError}=req('telegram/errors/index.js');
 let queued=0;
 const shared=Object.assign(Object.create(TelegramClient.prototype),{_requestRetries:5,_floodSleepThreshold:60,_connectedDeferred:{promise:Promise.resolve()},_sender:{addStateToQueue(state){queued++;state.reject(new FloodWaitError({request:state.request,capture:1}));}}});
 const isolated=Object.create(shared,{_requestRetries:{value:1},_floodSleepThreshold:{value:0}});
 await assert.rejects(pinnedInvoke(isolated,new Api.help.GetConfig({})),/wait/i);
 assert.equal(queued,1);assert.equal(shared._requestRetries,5);assert.equal(shared.floodSleepThreshold,60);assert.equal(isolated._sender,shared._sender);
 console.log('PASS: M21 same-ID video replacement, dryRun, own/account/peer/CAS/path guards, native entities, geometry, progress, no send/delete/retry, unknown outcomes');
} finally {
 delete process.env.M21_FIXTURE_FORMAT;
 if(previousProbe===undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH=previousProbe;
 rmSync(dir,{recursive:true,force:true});
}
