// Telegram MCP Starter (M21): same-message video replacement through the existing owner.
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Api } from "telegram/tl/index.js";
import { CustomFile } from "telegram/client/uploads.js";
import { isSafeAbsolutePath } from "./tools/shared.js";

function refuse(code, detail) {
    const error = new Error(`${code}: ${detail}`);
    error.code = code;
    throw error;
}
function captionSha256(text, entities = []) {
    // TL toJSON may contain stale offsets after parsing; serialize actual properties.
    const hash = createHash("sha256").update(JSON.stringify(text));
    for (const entity of entities) hash.update(entity.getBytes());
    return hash.digest("hex");
}
function statStamp(s) { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
function sourceStamp(path) { return statStamp(statSync(path)); }
async function hashSource(path, expectedStamp, onProgress) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const start = await handle.stat();
        if (!start.isFile() || statStamp(start) !== expectedStamp)
            refuse("MEDIA_REPLACE_SOURCE_CHANGED", "source changed before hashing");
        const hash = createHash("sha256");
        let heartbeatAt = 0;
        // Streaming keeps the existing owner responsive and avoids buffering multi-GiB video.
        for await (const chunk of handle.createReadStream({autoClose:false,highWaterMark:1024*1024})) {
            hash.update(chunk);
            if (typeof onProgress === "function" && Date.now() - heartbeatAt >= 1000) {
                heartbeatAt = Date.now();
                try { onProgress(0, 1); } catch { }
            }
        }
        if (statStamp(await handle.stat()) !== expectedStamp || sourceStamp(path) !== expectedStamp)
            refuse("MEDIA_REPLACE_SOURCE_CHANGED", "source changed while hashing");
        return hash.digest("hex");
    } catch (e) {
        if (e.code?.startsWith("MEDIA_REPLACE")) throw e;
        refuse("MEDIA_REPLACE_SOURCE_CHANGED", "source became unavailable while hashing");
    } finally { await handle?.close(); }
}
function messagePeerKey(peer) {
    if (peer instanceof Api.PeerUser) return `user:${peer.userId}`;
    if (peer instanceof Api.PeerChat) return `chat:${peer.chatId}`;
    if (peer instanceof Api.PeerChannel) return `channel:${peer.channelId}`;
    return undefined;
}
async function checkRights(client, peer, accountId) {
    if (peer instanceof Api.InputPeerSelf || peer instanceof Api.InputPeerUser) return {creator:false, admin:false};
    const chat = await client.getEntity(peer);
    if (chat.left || chat.kicked || chat.deactivated || chat.broadcast || chat.restricted)
        refuse("MEDIA_REPLACE_RIGHTS", "chat is unavailable, restricted or a broadcast");
    let creator = !!chat.creator, admin = !!chat.adminRights, banned;
    if (peer instanceof Api.InputPeerChannel) {
        const result = await client.getParticipant(peer, new Api.InputPeerSelf({}));
        const participant = result?.participant;
        if (!participant || participant.userId?.toString() !== accountId || participant.left)
            refuse("MEDIA_REPLACE_RIGHTS", "current account membership could not be verified");
        creator = creator || participant instanceof Api.ChannelParticipantCreator;
        admin = admin || !!participant.adminRights;
        banned = participant.bannedRights;
    }
    const forbids = r => r && (r.viewMessages || r.sendMessages || r.sendMedia || r.sendVideos || r.sendPlain);
    if (forbids(banned) || (!creator && !admin && forbids(chat.defaultBannedRights)))
        refuse("MEDIA_REPLACE_RIGHTS", "current account cannot write video/caption here");
    return {creator, admin};
}
export async function replaceMessageMedia(service, args, onProgress, probeVideo, inputPeerKey) {
    const client = service.client;
    if (!client || !service.connected) refuse("MEDIA_REPLACE_NOT_CONNECTED", "connect the existing owner first");
    const { chatId, messageId, filePath, expectedAccountId, expectedPeerKey, expectedDocumentId, expectedCaptionSha256, expectedSourceSha256, caption, parseMode, dryRun = true } = args;
    if (typeof dryRun !== "boolean" || !Number.isSafeInteger(messageId) || messageId <= 0 || typeof chatId !== "string" || !chatId)
        refuse("MEDIA_REPLACE_INPUT", "invalid dryRun/chatId/messageId");
    if (!/^\d+$/.test(expectedAccountId ?? "")) refuse("MEDIA_REPLACE_INPUT", "expectedAccountId is required");
    if (!dryRun && (!expectedPeerKey || !/^\d+$/.test(expectedDocumentId ?? "") || !/^[a-f0-9]{64}$/.test(expectedCaptionSha256 ?? "") || !/^[a-f0-9]{64}$/.test(expectedSourceSha256 ?? "")))
        refuse("MEDIA_REPLACE_INPUT", "apply requires exact peer/document/caption/source SHA baseline from dryRun");
    if (!isSafeAbsolutePath(filePath)) refuse("MEDIA_REPLACE_PATH", "expected a safe absolute local file path");
    let canonicalPath, fileSize, stamp;
    try {
        if (!lstatSync(filePath).isFile()) refuse("MEDIA_REPLACE_PATH", "source must be a regular file, not a symlink");
        canonicalPath = realpathSync(filePath);
        if (!isSafeAbsolutePath(canonicalPath)) refuse("MEDIA_REPLACE_PATH", "resolved source is not allowed");
        accessSync(canonicalPath, constants.R_OK);
        const source = statSync(canonicalPath);
        if (!source.isFile() || !Number.isSafeInteger(source.size) || source.size <= 0) refuse("MEDIA_REPLACE_PATH", "source must be a nonempty regular file");
        fileSize = source.size; stamp = sourceStamp(canonicalPath);
    } catch (e) {
        if (e.code?.startsWith("MEDIA_REPLACE")) throw e;
        refuse("MEDIA_REPLACE_PATH", "source is unavailable or unreadable");
    }
    const me = await client.getMe();
    const accountId = me.id.toString();
    if (accountId !== expectedAccountId) refuse("MEDIA_REPLACE_ACCOUNT", "current account differs from expectedAccountId");
    const config = await client.invoke(new Api.help.GetAppConfig({hash:0}));
    const uploadLimitKey = me.premium ? "upload_max_fileparts_premium" : "upload_max_fileparts_default";
    const partsLimit = config?.config?.value?.find(entry => entry.key === uploadLimitKey)?.value?.value;
    if (!Number.isSafeInteger(partsLimit) || partsLimit <= 0) refuse("MEDIA_REPLACE_LIMITS", "live account upload limit is unavailable");
    const uploadLimitBytes = partsLimit * 512 * 1024;
    if (fileSize > uploadLimitBytes) refuse("MEDIA_REPLACE_FILE_TOO_LARGE", "file exceeds live account upload limit");
    if (extname(canonicalPath).toLowerCase() !== ".mp4") refuse("MEDIA_REPLACE_VIDEO", "replacement currently supports MP4 only");
    const resolved = await service.resolvePeer(chatId);
    const peer = await client.getInputEntity(resolved);
    const rawPeerKey = inputPeerKey(peer);
    // me/self and numeric self aliases must share CAS identity and the upload lock.
    const peerKey = rawPeerKey === "self" ? `user:${accountId}` : rawPeerKey;
    if (!/^(self|user:\d+|chat:\d+|channel:\d+)$/.test(peerKey)) refuse("MEDIA_REPLACE_PEER", "unsupported resolved peer");
    if (expectedPeerKey !== undefined && peerKey !== expectedPeerKey) refuse("MEDIA_REPLACE_CONFLICT", "resolved peer changed");
    const rights = await checkRights(client, peer, accountId);
    const readBaseline = async () => {
        const message = (await client.getMessages(peer, { ids: [messageId] }))[0];
        const nativePeer = messagePeerKey(message?.peerId);
        const targetPeer = peerKey === "self" ? `user:${accountId}` : peerKey;
        const ownSaved = targetPeer === `user:${accountId}` && nativePeer === targetPeer
            && message?.senderId?.toString() === accountId
            && (message.fromId == null || messagePeerKey(message.fromId) === `user:${accountId}`);
        const ownOutgoing = message?.out === true && messagePeerKey(message.fromId) === `user:${accountId}`;
        const doc = message?.media?.document;
        if (message?.id !== messageId || nativePeer !== targetPeer || (!ownOutgoing && !ownSaved) || message.fwdFrom || message.post || message.groupedId || message.richMessage || message.media?.ttlSeconds
            || !(message.media instanceof Api.MessageMediaDocument) || !(doc instanceof Api.Document)
            || !doc.attributes?.some(a => a instanceof Api.DocumentAttributeVideo && !a.roundMessage))
            refuse("MEDIA_REPLACE_NOT_OWN_VIDEO", "requires a single existing own direct video message");
        const text = message.message ?? "";
        const entities = message.entities ?? [];
        return { message, text, entities, baseline: {accountId, peerKey, messageId, documentId: doc.id.toString(), captionSha256: captionSha256(text, entities)} };
    };
    const before = await readBaseline();
    const baseline = before.baseline;
    if ((expectedDocumentId !== undefined && baseline.documentId !== expectedDocumentId) || (expectedCaptionSha256 !== undefined && baseline.captionSha256 !== expectedCaptionSha256))
        refuse("MEDIA_REPLACE_CONFLICT", "existing video or caption/entities changed");
    const timeConfig = await client.invoke(new Api.help.GetConfig({}));
    const editTimeLimitSeconds = timeConfig.editTimeLimit;
    if (!Number.isSafeInteger(editTimeLimitSeconds) || editTimeLimitSeconds <= 0) refuse("MEDIA_REPLACE_LIMITS", "live edit time limit is unavailable");
    const checkWindow = (message, permissions) => {
        const saved = peerKey === "self" || peerKey === `user:${accountId}`;
        const privileged = !!(permissions.creator || permissions.admin);
        if (!Number.isFinite(message.date)) refuse("MEDIA_REPLACE_LIMITS", "message date is unavailable");
        const ageSeconds = Math.max(0, Math.floor(Date.now()/1000) - message.date);
        if (!saved && !privileged && ageSeconds > editTimeLimitSeconds) refuse("MEDIA_REPLACE_EDIT_EXPIRED", "message exceeds live edit window and account has no admin/creator metadata");
        return {editTimeLimitSeconds,ageSeconds,savedDialog:saved,privilegedMetadata:privileged,serverEnforced:true};
    };
    const editWindow = checkWindow(before.message, rights);
    const prepared = await service.prepareMediaCaption(caption === undefined ? before.text : caption, parseMode);
    if (prepared.accountId !== accountId) refuse("MEDIA_REPLACE_ACCOUNT", "account changed during caption preflight");
    const text = caption === undefined ? before.text : prepared.text;
    const entities = caption === undefined ? before.entities : prepared.entities;
    if (caption === undefined && parseMode !== undefined) refuse("MEDIA_REPLACE_INPUT", "parseMode requires an explicit caption");
    const plannedCaptionSha256 = captionSha256(text, entities);
    const video = probeVideo(canonicalPath, true);
    if (!video) refuse("MEDIA_REPLACE_VIDEO", "source must have a supported video extension and verified video stream");
    if (!video.formatName?.split(",").includes("mp4")) refuse("MEDIA_REPLACE_VIDEO", "ffprobe did not verify an MP4-family container");
    const sourceSha256 = await hashSource(canonicalPath, stamp, onProgress);
    if (expectedSourceSha256 !== undefined && sourceSha256 !== expectedSourceSha256) refuse("MEDIA_REPLACE_SOURCE_CONFLICT", "source SHA-256 differs from the reviewed dryRun");
    const preview = {dryRun: true, sourceSha256, baseline, editWindow, uploadLimitBytes, size: fileSize, video: {...video, supportsStreaming:true}, captionPreserved: caption === undefined, plannedCaptionSha256};
    if (dryRun) return preview;
    // One lock per target message also excludes concurrent uploads from other paths/aliases.
    const key = `replace:${accountId}:${peerKey}:${messageId}`;
    if (service.uploadsInFlight.has(key)) refuse("MEDIA_REPLACE_IN_PROGRESS", "replacement for this message is already running");
    service.uploadsInFlight.add(key);
    try {
        // Hashing is asynchronous: reconcile again under the target lock before uploading.
        const uploadBaseline = await readBaseline();
        if (uploadBaseline.baseline.documentId !== baseline.documentId || uploadBaseline.baseline.captionSha256 !== baseline.captionSha256)
            refuse("MEDIA_REPLACE_CONFLICT", "target changed during source hashing; no upload requested");
        if ((await client.getMe()).id.toString() !== accountId)
            refuse("MEDIA_REPLACE_ACCOUNT", "account changed during source hashing");
        if (sourceStamp(canonicalPath) !== stamp)
            refuse("MEDIA_REPLACE_SOURCE_CHANGED", "source changed after hashing; no upload requested");
        let lastProgressAt = 0;
        const progress = typeof onProgress === "function" ? fraction => {
            const now = Date.now();
            if (now - lastProgressAt >= 1000 || fraction === 1) {
                lastProgressAt = now;
                try { onProgress(Number(fraction), 1); } catch { /* observers cannot turn an accepted edit into a failure */ }
            }
        } : undefined;
        let file;
        try { file = await client.uploadFile({file:new CustomFile(basename(canonicalPath), fileSize, canonicalPath), workers:4, onProgress:progress}); }
        catch { refuse("MEDIA_REPLACE_UPLOAD_FAILED", "upload failed before the edit request; no automatic retry"); }
        if (sourceStamp(canonicalPath) !== stamp) refuse("MEDIA_REPLACE_SOURCE_CHANGED", "local source changed during upload; no edit requested");
        const now = await readBaseline();
        if (now.baseline.documentId !== baseline.documentId || now.baseline.captionSha256 !== baseline.captionSha256)
            refuse("MEDIA_REPLACE_CONFLICT", "target changed during upload; no edit requested");
        if ((await client.getMe()).id.toString() !== accountId) refuse("MEDIA_REPLACE_ACCOUNT", "account changed during upload");
        checkWindow(now.message, await checkRights(client, peer, accountId));
        const media = new Api.InputMediaUploadedDocument({file, mimeType:"video/mp4", spoiler:now.message.media.spoiler, attributes:[
            new Api.DocumentAttributeFilename({fileName:basename(canonicalPath)}),
            new Api.DocumentAttributeVideo({duration:video.duration,w:video.width,h:video.height,supportsStreaming:true}),
        ]});
        const unknown = {status:"outcome_unknown", messageId, baseline, retryAllowed:false, reconciliation:"Read this exact peer/messageId before any further upload or edit."};
        try {
            // Exactly one edit request. Never rateLimiter.execute, sendFile, SendMedia or delete.
            // Shadow only per-call retry controls; sender/session remain the same owner.
            // Never mutate the shared client's controls while other tools may be running.
            const once = Object.create(client, {_requestRetries:{value:1}, _floodSleepThreshold:{value:0}});
            await once.invoke(new Api.messages.EditMessage({peer,id:messageId,message:text,entities,media}));
        } catch (e) {
            // Explicit RPC rejections are known failures; a lost transport response is unknown.
            if (Number.isInteger(e?.code) && e.code >= 400 && e.code < 500 && e?.errorMessage) refuse("MEDIA_REPLACE_RPC_REJECTED", String(e.errorMessage).replace(/[^A-Z0-9_]/g, "").slice(0,100));
            return unknown;
        }
        try {
            const after = await readBaseline();
            const doc = after.message.media.document;
            const attr = doc.attributes.find(a => a instanceof Api.DocumentAttributeVideo);
            if (after.baseline.documentId === baseline.documentId || after.baseline.captionSha256 !== plannedCaptionSha256 || doc.size.toString() !== String(fileSize)
                || attr.w !== video.width || attr.h !== video.height || Math.ceil(attr.duration) !== video.duration || !attr.supportsStreaming || !doc.mimeType?.startsWith("video/"))
                return {...unknown, verification:"read-back metadata differs from plan"};
            return {status:"verified", messageId, baseline, documentId:after.baseline.documentId, size:fileSize, sourceSha256, video:preview.video, captionPreserved:preview.captionPreserved, captionSha256:after.baseline.captionSha256};
        } catch { return unknown; }
    } finally { service.uploadsInFlight.delete(key); }
}
