import { randomBytes } from "node:crypto";
import bigInt from "big-integer";
import { Api } from "telegram/tl/index.js";
import { createRequire } from "node:module";  // Telegram MCP Starter (R4b): ленивая загрузка Rich teleproto
// Telegram MCP Starter (R4): Rich-сообщения Telegram (слой 229). gramJS 2.26.22 их не знает —
// у такого сообщения пустой message, и MCP отдавал пустой текст. teleproto (форк gramJS,
// ставится npm-алиасом вместо «telegram») даёт message.richMessage и рендер Rich.*.
// Модули грузим лениво и терпим их отсутствие: на gramJS правка вырождается в прежнее
// поведение (text = message), а не роняет демона на импорте. Загрузчик один на пакет —
// его берут telegram-client.js и сводки ниже (Telegram MCP Starter R4b).
const fisRequire = createRequire(import.meta.url);
let fisTeleprotoMods;
export function fisTeleproto() {
    if (fisTeleprotoMods === undefined) {
        try {
            const pkg = fisRequire("telegram/package.json");
            fisTeleprotoMods = pkg.name === "teleproto" ? { rich: fisRequire("telegram/richMessage.js") } : null;
        }
        catch {
            fisTeleprotoMods = null;
        }
    }
    return fisTeleprotoMods;
}
/** Telegram MCP Starter (R4b): текст сообщения с учётом Rich — markdown блоков или message. */
export function fisMessageText(msg) {
    const tp = fisTeleproto();
    const r = msg?.richMessage;
    if (tp && r && r.className === "RichMessage") {
        try {
            return tp.rich.toMarkdown(r) || msg.message || "";
        }
        catch {
            try {
                return tp.rich.toPlainText(r) || msg.message || "";
            }
            catch { }
        }
    }
    return msg?.message ?? "";
}
/** Telegram MCP Starter (R4b): поля «rich» для сводок — пусто у обычного сообщения. */
export function fisRichFlag(msg) {
    return fisTeleproto() && msg?.richMessage?.className === "RichMessage"
        ? { rich: true, ...(msg.richMessage.part ? { richPartial: true } : {}) }
        : {};
}
/**
 * Build an InputReplyToMessage from optional replyTo / topicId, matching the shape used by
 * raw messages.SendMedia. Returns undefined when neither is set so the caller can spread-omit it.
 */
export function buildReplyTo(replyTo, topicId) {
    if (!replyTo && !topicId)
        return undefined;
    // Telegram expects replyToMsgId to equal topicId when replying to the topic root
    // (posting into a topic without quoting a specific message inside it).
    return new Api.InputReplyToMessage({
        replyToMsgId: (replyTo ?? topicId),
        topMsgId: topicId,
    });
}
/** Cryptographically random 64-bit bigInt for TL randomId (SendMedia/SendMultiMedia require it). */
export function generateRandomBigInt() {
    return bigInt(randomBytes(8).toString("hex"), 16);
}
/**
 * Extract the server-assigned message ID from an Updates envelope returned by SendMedia/SendMessage.
 * Prefers UpdateMessageID (authoritative for SendMedia), falls back to UpdateNewMessage /
 * UpdateNewChannelMessage for safety. Returns undefined when no ID is found.
 */
export function extractMessageId(result) {
    if (!result)
        return undefined;
    if (result instanceof Api.Message)
        return result.id;
    if (result instanceof Api.UpdateShortSentMessage)
        return result.id;
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
        for (const u of result.updates) {
            if (u instanceof Api.UpdateMessageID)
                return u.id;
        }
        for (const u of result.updates) {
            if (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) {
                if (u.message instanceof Api.Message)
                    return u.message.id;
            }
        }
    }
    return undefined;
}
/**
 * Extract the MessageMediaDice value and captured message ID from a SendMedia dice envelope.
 * Value is only present in UpdateNewMessage/UpdateNewChannelMessage; UpdateMessageID carries the ID only.
 */
export function extractDiceResult(result) {
    if (!result)
        return undefined;
    if (!(result instanceof Api.Updates) && !(result instanceof Api.UpdatesCombined))
        return undefined;
    let id;
    let value;
    for (const u of result.updates) {
        if (u instanceof Api.UpdateMessageID && id === undefined)
            id = u.id;
        if (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) {
            if (u.message instanceof Api.Message) {
                if (id === undefined)
                    id = u.message.id;
                if (u.message.media instanceof Api.MessageMediaDice)
                    value = u.message.media.value;
            }
        }
    }
    if (id === undefined)
        return undefined;
    return { id, value };
}
export function describeAdminLogAction(action) {
    const prefix = "ChannelAdminLogEventAction";
    const raw = action.className.startsWith(prefix) ? action.className.slice(prefix.length) : action.className;
    return raw
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase();
}
export function describeAdminLogDetails(action, describeUser) {
    if (action instanceof Api.ChannelAdminLogEventActionChangeTitle) {
        return `"${action.prevValue}" → "${action.newValue}"`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionChangeAbout) {
        return `description changed`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionChangeUsername) {
        return `@${action.prevValue || "-"} → @${action.newValue || "-"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionUpdatePinned) {
        return `message #${action.message instanceof Api.Message ? action.message.id : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionEditMessage) {
        return `message #${action.newMessage instanceof Api.Message ? action.newMessage.id : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionDeleteMessage) {
        return `message #${action.message instanceof Api.Message ? action.message.id : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionParticipantInvite) {
        const p = action.participant;
        return `invited user ${"userId" in p ? describeUser(p.userId) : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionParticipantToggleBan) {
        const p = action.newParticipant;
        if (p instanceof Api.ChannelParticipantBanned) {
            const uid = p.peer instanceof Api.PeerUser ? p.peer.userId : undefined;
            return `banned user ${uid ? describeUser(uid) : "?"}`;
        }
        return `unbanned user ${"userId" in p ? describeUser(p.userId) : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionParticipantToggleAdmin) {
        const p = action.newParticipant;
        return `admin rights changed for ${"userId" in p ? describeUser(p.userId) : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionToggleSlowMode) {
        return `${action.prevValue}s → ${action.newValue}s`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionToggleInvites) {
        return `invites ${action.newValue ? "enabled" : "disabled"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionToggleSignatures) {
        return `signatures ${action.newValue ? "enabled" : "disabled"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionTogglePreHistoryHidden) {
        return `pre-history hidden: ${action.newValue}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionChangeHistoryTTL) {
        return `${action.prevValue}s → ${action.newValue}s`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionChangeStickerSet) {
        return `sticker set changed`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionChangeLinkedChat) {
        return `${action.prevValue.toString()} → ${action.newValue.toString()}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionStopPoll) {
        return `poll in message #${action.message instanceof Api.Message ? action.message.id : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionSendMessage) {
        return `message #${action.message instanceof Api.Message ? action.message.id : "?"}`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionCreateTopic) {
        return `topic "${action.topic instanceof Api.ForumTopic ? action.topic.title : "?"}"`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionDeleteTopic) {
        return `topic "${action.topic instanceof Api.ForumTopic ? action.topic.title : "?"}"`;
    }
    if (action instanceof Api.ChannelAdminLogEventActionEditTopic) {
        return `topic "${action.newTopic instanceof Api.ForumTopic ? action.newTopic.title : "?"}"`;
    }
    return "";
}
export function reactionToEmoji(reaction) {
    if (reaction instanceof Api.ReactionEmoji)
        return reaction.emoticon;
    if (reaction instanceof Api.ReactionCustomEmoji)
        return `custom:${reaction.documentId.toString()}`;
    if (reaction instanceof Api.ReactionPaid)
        return "⭐";
    return null;
}
function absValue(v) {
    return { current: v?.current ?? 0, previous: v?.previous ?? 0 };
}
function compactGraph(g) {
    if (g instanceof Api.StatsGraphAsync)
        return { type: "async", token: g.token };
    if (g instanceof Api.StatsGraphError)
        return { type: "error", error: g.error };
    if (g instanceof Api.StatsGraph) {
        let parsed = g.json?.data;
        if (typeof parsed === "string") {
            try {
                parsed = JSON.parse(parsed);
            }
            catch {
                // leave raw string
            }
        }
        return { type: "data", data: parsed, zoomToken: g.zoomToken };
    }
    const graph = g;
    if (typeof graph.token === "string")
        return { type: "async", token: graph.token };
    if (typeof graph.error === "string")
        return { type: "error", error: graph.error };
    return { type: "data", data: graph.json?.data, zoomToken:
            graph.zoomToken };
}
export function summarizeMegagroupStats(stats, includeGraphs) {
    const summary = {
        period: {
            minDate: stats.period?.minDate ?? 0,
            maxDate: stats.period?.maxDate ?? 0,
        },
        members: absValue(stats.members),
        messages: absValue(stats.messages),
        viewers: absValue(stats.viewers),
        posters: absValue(stats.posters),
        topPosters: (stats.topPosters ?? []).map((p) => ({
            userId: p.userId?.toString() ?? "",
            messages: p.messages,
            avgChars: p.avgChars,
        })),
        topAdmins: (stats.topAdmins ?? []).map((a) => ({
            userId: a.userId?.toString() ?? "",
            deleted: a.deleted,
            kicked: a.kicked,
            banned: a.banned,
        })),
        topInviters: (stats.topInviters ?? []).map((i) => ({
            userId: i.userId?.toString() ?? "",
            invitations: i.invitations,
        })),
    };
    if (includeGraphs) {
        summary.graphs = {
            growth: compactGraph(stats.growthGraph),
            members: compactGraph(stats.membersGraph),
            newMembersBySource: compactGraph(stats.newMembersBySourceGraph),
            languages: compactGraph(stats.languagesGraph),
            messages: compactGraph(stats.messagesGraph),
            actions: compactGraph(stats.actionsGraph),
            topHours: compactGraph(stats.topHoursGraph),
            weekdays: compactGraph(stats.weekdaysGraph),
        };
    }
    return summary;
}
export function summarizeBroadcastStats(stats, includeGraphs) {
    const enabled = stats.enabledNotifications;
    const part = enabled?.part ?? 0;
    const total = enabled?.total ?? 0;
    const percent = total > 0 ? (part / total) * 100 : 0;
    const summary = {
        period: {
            minDate: stats.period?.minDate ?? 0,
            maxDate: stats.period?.maxDate ?? 0,
        },
        followers: absValue(stats.followers),
        viewsPerPost: absValue(stats.viewsPerPost),
        sharesPerPost: absValue(stats.sharesPerPost),
        reactionsPerPost: absValue(stats.reactionsPerPost),
        viewsPerStory: absValue(stats.viewsPerStory),
        sharesPerStory: absValue(stats.sharesPerStory),
        reactionsPerStory: absValue(stats.reactionsPerStory),
        enabledNotifications: { part, total, percent },
        recentPostsInteractions: (stats.recentPostsInteractions ?? []).map((p) => {
            if (p instanceof Api.PostInteractionCountersStory) {
                return {
                    kind: "story",
                    storyId: p.storyId,
                    views: p.views,
                    forwards: p.forwards,
                    reactions: p.reactions,
                };
            }
            const m = p;
            return {
                kind: "message",
                msgId: m.msgId,
                views: m.views,
                forwards: m.forwards,
                reactions: m.reactions,
            };
        }),
    };
    if (includeGraphs) {
        summary.graphs = {
            growth: compactGraph(stats.growthGraph),
            followers: compactGraph(stats.followersGraph),
            mute: compactGraph(stats.muteGraph),
            topHours: compactGraph(stats.topHoursGraph),
            interactions: compactGraph(stats.interactionsGraph),
            ivInteractions: compactGraph(stats.ivInteractionsGraph),
            viewsBySource: compactGraph(stats.viewsBySourceGraph),
            newFollowersBySource: compactGraph(stats.newFollowersBySourceGraph),
            languages: compactGraph(stats.languagesGraph),
            reactionsByEmotion: compactGraph(stats.reactionsByEmotionGraph),
            storyInteractions: compactGraph(stats.storyInteractionsGraph),
            storyReactionsByEmotion: compactGraph(stats.storyReactionsByEmotionGraph),
        };
    }
    return summary;
}
const BANNED_RIGHT_FLAGS = [
    "sendMessages",
    "sendMedia",
    "sendStickers",
    "sendGifs",
    "sendPolls",
    "sendInline",
    "embedLinks",
    "changeInfo",
    "inviteUsers",
    "pinMessages",
];
// Newer granular flags not exposed in ChatPermissions input but must be preserved from currentRights
const EXTRA_BANNED_RIGHT_FLAGS = [
    "sendGames",
    "manageTopics",
    "sendPhotos",
    "sendVideos",
    "sendRoundvideos",
    "sendAudios",
    "sendVoices",
    "sendDocs",
    "sendPlain",
];
export function mergeBannedRights(current, permissions) {
    const result = {};
    for (const flag of BANNED_RIGHT_FLAGS) {
        const userValue = permissions[flag];
        if (userValue !== undefined) {
            result[flag] = !userValue;
        }
        else {
            result[flag] = Boolean(current?.[flag]);
        }
    }
    // Preserve newer granular flags from existing rights so they are not silently cleared
    for (const flag of EXTRA_BANNED_RIGHT_FLAGS) {
        result[flag] = Boolean(current?.[flag]);
    }
    return result;
}
export function describeKeyboardButton(button, row, col) {
    const base = {
        row,
        col,
        type: button.className,
        label: "text" in button && typeof button.text === "string" ? button.text : "",
    };
    if (button instanceof Api.KeyboardButtonCallback) {
        base.data = Buffer.from(button.data).toString("base64");
        if (button.requiresPassword)
            base.requiresPassword = true;
        return base;
    }
    if (button instanceof Api.KeyboardButtonUrl) {
        base.url = button.url;
        return base;
    }
    if (button instanceof Api.KeyboardButtonUrlAuth) {
        base.url = button.url;
        base.buttonId = button.buttonId;
        return base;
    }
    if (button instanceof Api.KeyboardButtonSwitchInline) {
        base.switchQuery = button.query;
        base.samePeer = Boolean(button.samePeer);
        return base;
    }
    if (button instanceof Api.KeyboardButtonWebView || button instanceof Api.KeyboardButtonSimpleWebView) {
        base.url = button.url;
        return base;
    }
    if (button instanceof Api.KeyboardButtonUserProfile) {
        base.userId = button.userId?.toString();
        return base;
    }
    if (button instanceof Api.KeyboardButtonRequestPoll) {
        if (button.quiz)
            base.quiz = true;
        return base;
    }
    if (button instanceof Api.KeyboardButtonRequestPeer) {
        base.buttonId = button.buttonId;
        return base;
    }
    if (button instanceof Api.KeyboardButtonCopy) {
        base.copyText = button.copyText;
        return base;
    }
    return base;
}
export function peerToCompact(peer) {
    if (!peer)
        return undefined;
    if (peer instanceof Api.PeerUser)
        return { kind: "user", id: peer.userId.toString() };
    if (peer instanceof Api.PeerChat)
        return { kind: "chat", id: peer.chatId.toString() };
    if (peer instanceof Api.PeerChannel)
        return { kind: "channel", id: peer.channelId.toString() };
    return undefined;
}
function summarizeMessageForUpdates(msg) {
    if (msg instanceof Api.MessageEmpty)
        return null;
    const peer = peerToCompact(msg.peerId);
    if (!peer)
        return null;
    const fromId = peerToCompact(msg.fromId);
    const date = msg.date ?? 0;
    if (msg instanceof Api.Message) {
        return { id: msg.id, peer, fromId, date, text: fisMessageText(msg), ...fisRichFlag(msg), isService: false };  // Telegram MCP Starter (R4b)
    }
    if (msg instanceof Api.MessageService) {
        return {
            id: msg.id,
            peer,
            fromId,
            date,
            text: `[${msg.action?.className ?? "service"}]`,
            isService: true,
        };
    }
    return null;
}
function collectDeletedMessageIds(updates) {
    const out = [];
    for (const u of updates) {
        if (u instanceof Api.UpdateDeleteMessages) {
            out.push({ messageIds: u.messages });
        }
        else if (u instanceof Api.UpdateDeleteChannelMessages) {
            out.push({
                peer: { kind: "channel", id: u.channelId.toString() },
                messageIds: u.messages,
            });
        }
    }
    return out;
}
export function summarizeUpdatesDifference(diff, cursor) {
    if (diff instanceof Api.updates.DifferenceEmpty) {
        return {
            state: { pts: cursor.pts, qts: cursor.qts, date: diff.date, seq: diff.seq },
            isFinal: true,
            newMessages: [],
            deletedMessageIds: [],
            otherUpdates: [],
        };
    }
    if (diff instanceof Api.updates.DifferenceTooLong) {
        return {
            state: { pts: diff.pts, qts: cursor.qts, date: cursor.date, seq: 0 },
            isFinal: true,
            newMessages: [],
            deletedMessageIds: [],
            otherUpdates: [],
            fallback: {
                kind: "tooLong",
                suggestedAction: "gap too large — call telegram-read-messages per chat or telegram-get-state to resync",
            },
        };
    }
    const isFinal = diff instanceof Api.updates.Difference;
    const state = isFinal
        ? diff.state
        : diff.intermediateState;
    const newMessages = (diff.newMessages ?? [])
        .map(summarizeMessageForUpdates)
        .filter((m) => m !== null);
    const otherUpdates = diff.otherUpdates ?? [];
    return {
        state: {
            pts: state.pts,
            qts: state.qts,
            date: state.date,
            seq: state.seq,
            unreadCount: state.unreadCount,
        },
        isFinal,
        newMessages,
        deletedMessageIds: collectDeletedMessageIds(otherUpdates),
        otherUpdates: otherUpdates.map((u) => ({ type: u.className })),
    };
}
export function summarizeChannelDifference(diff, channelId, fallbackPts) {
    if (diff instanceof Api.updates.ChannelDifferenceEmpty) {
        return {
            channelId,
            pts: diff.pts,
            isFinal: Boolean(diff.final),
            timeout: diff.timeout,
            newMessages: [],
            otherUpdates: [],
        };
    }
    if (diff instanceof Api.updates.ChannelDifferenceTooLong) {
        const freshPts = diff.dialog instanceof Api.Dialog ? (diff.dialog.pts ?? fallbackPts) : fallbackPts;
        return {
            channelId,
            pts: freshPts,
            isFinal: Boolean(diff.final),
            timeout: diff.timeout,
            newMessages: (diff.messages ?? [])
                .map(summarizeMessageForUpdates)
                .filter((m) => m !== null),
            otherUpdates: [],
            fallback: {
                kind: "tooLong",
                suggestedAction: "channel gap too large — dialog snapshot returned; call telegram-read-messages for full history",
            },
        };
    }
    if (diff instanceof Api.updates.ChannelDifference) {
        return {
            channelId,
            pts: diff.pts,
            isFinal: Boolean(diff.final),
            timeout: diff.timeout,
            newMessages: (diff.newMessages ?? [])
                .map(summarizeMessageForUpdates)
                .filter((m) => m !== null),
            otherUpdates: (diff.otherUpdates ?? []).map((u) => ({ type: u.className })),
        };
    }
    return {
        channelId,
        pts: fallbackPts,
        isFinal: false,
        newMessages: [],
        otherUpdates: [],
    };
}
export function summarizeMyBoost(boost) {
    const b = boost;
    return {
        slot: b.slot,
        peer: peerToCompact(b.peer),
        date: b.date,
        expires: b.expires,
        cooldownUntilDate: b.cooldownUntilDate,
    };
}
export function summarizeMyBoosts(result) {
    const boosts = result.myBoosts ?? [];
    return {
        count: boosts.length,
        myBoosts: boosts.map(summarizeMyBoost),
    };
}
export function summarizePrepaidGiveaway(g) {
    if (g instanceof Api.PrepaidStarsGiveaway) {
        return {
            kind: "stars",
            id: g.id.toString(),
            quantity: g.quantity,
            date: g.date,
            stars: g.stars.toString(),
            boosts: g.boosts,
        };
    }
    const p = g;
    return {
        kind: "premium",
        id: p.id.toString(),
        quantity: p.quantity,
        date: p.date,
        months: p.months,
    };
}
export function summarizeBoostsStatus(result) {
    const r = result;
    const out = {
        level: r.level,
        boosts: r.boosts,
        currentLevelBoosts: r.currentLevelBoosts,
        nextLevelBoosts: r.nextLevelBoosts,
        giftBoosts: r.giftBoosts,
        boostUrl: r.boostUrl,
        myBoost: r.myBoost,
        myBoostSlots: r.myBoostSlots,
    };
    if (r.premiumAudience) {
        out.premiumAudience = { part: r.premiumAudience.part, total: r.premiumAudience.total };
    }
    if (r.prepaidGiveaways && r.prepaidGiveaways.length > 0) {
        out.prepaidGiveaways = r.prepaidGiveaways.map(summarizePrepaidGiveaway);
    }
    return out;
}
export function summarizeBoost(boost) {
    const b = boost;
    return {
        id: b.id,
        userId: b.userId?.toString(),
        date: b.date,
        expires: b.expires,
        gift: b.gift,
        giveaway: b.giveaway,
        unclaimed: b.unclaimed,
        giveawayMsgId: b.giveawayMsgId,
        usedGiftSlug: b.usedGiftSlug,
        multiplier: b.multiplier,
        stars: b.stars?.toString(),
    };
}
export function summarizeBoostsList(result) {
    const r = result;
    return {
        count: r.count,
        boosts: (r.boosts ?? []).map(summarizeBoost),
        nextOffset: r.nextOffset,
    };
}
/**
 * Map a `users.SavedMusic` response to the tool payload. Pure — no client access.
 *
 * `id` and `size` are big-integer instances and must be stringified: JSON.stringify emits
 * `{}` for them otherwise.
 */
export function summarizeSavedMusic(response, offset) {
    const tracks = response.documents.map((doc) => {
        const track = { id: doc.id.toString() };
        if (doc.mimeType)
            track.mimeType = doc.mimeType;
        if (doc.size !== undefined)
            track.size = doc.size.toString();
        const audio = doc.attributes?.find((a) => a instanceof Api.DocumentAttributeAudio);
        if (audio) {
            if (audio.title)
                track.title = audio.title;
            if (audio.performer)
                track.performer = audio.performer;
            if (audio.duration !== undefined)
                track.duration = audio.duration;
        }
        // Fallback label when the audio attribute carries no title/performer.
        const named = doc.attributes?.find((a) => a instanceof Api.DocumentAttributeFilename);
        if (named?.fileName)
            track.fileName = named.fileName;
        return track;
    });
    const out = { count: response.count, tracks };
    if (response.notModified)
        out.notModified = true;
    // Derive the page boundary from `count`, not `tracks.length < limit` — the two disagree
    // when the server short-pages a non-final page.
    const consumed = offset + tracks.length;
    if (consumed < response.count)
        out.nextOffset = consumed;
    return out;
}
export function summarizeBusinessChatLink(link) {
    const l = link;
    return {
        link: l.link,
        message: l.message,
        title: l.title,
        views: l.views,
        entityCount: l.entities?.length ?? 0,
    };
}
export function summarizeBusinessChatLinks(result) {
    const r = result;
    const links = r.links ?? [];
    return {
        count: links.length,
        links: links.map(summarizeBusinessChatLink),
    };
}
export function summarizeGroupCallInfo(call) {
    if (call instanceof Api.GroupCallDiscarded) {
        return {
            kind: "discarded",
            id: call.id.toString(),
            accessHash: call.accessHash.toString(),
            duration: call.duration,
        };
    }
    const c = call;
    return {
        kind: "active",
        id: c.id.toString(),
        accessHash: c.accessHash.toString(),
        participantsCount: c.participantsCount,
        title: c.title,
        scheduleDate: c.scheduleDate,
        recordStartDate: c.recordStartDate,
        streamDcId: c.streamDcId,
        unmutedVideoCount: c.unmutedVideoCount,
        unmutedVideoLimit: c.unmutedVideoLimit,
        version: c.version,
        joinMuted: c.joinMuted,
        canChangeJoinMuted: c.canChangeJoinMuted,
        joinDateAsc: c.joinDateAsc,
        scheduleStartSubscribed: c.scheduleStartSubscribed,
        canStartVideo: c.canStartVideo,
        recordVideoActive: c.recordVideoActive,
        rtmpStream: c.rtmpStream,
        listenersHidden: c.listenersHidden,
    };
}
export function summarizeGroupCallParticipant(p) {
    const gp = p;
    return {
        peer: peerToCompact(gp.peer),
        date: gp.date,
        activeDate: gp.activeDate,
        source: gp.source,
        volume: gp.volume,
        muted: gp.muted,
        left: gp.left,
        canSelfUnmute: gp.canSelfUnmute,
        justJoined: gp.justJoined,
        self: gp.self,
        mutedByYou: gp.mutedByYou,
        volumeByAdmin: gp.volumeByAdmin,
        videoJoined: gp.videoJoined,
        about: gp.about,
        raiseHandRating: gp.raiseHandRating?.toString(),
        hasVideo: gp.video ? true : undefined,
        hasPresentation: gp.presentation ? true : undefined,
    };
}
export function summarizeGroupCall(result) {
    const r = result;
    return {
        call: summarizeGroupCallInfo(r.call),
        participants: (r.participants ?? []).map(summarizeGroupCallParticipant),
        participantsNextOffset: r.participantsNextOffset || undefined,
    };
}
export function summarizeGroupCallParticipants(result) {
    const r = result;
    return {
        count: r.count,
        participants: (r.participants ?? []).map(summarizeGroupCallParticipant),
        nextOffset: r.nextOffset || undefined,
        version: r.version,
    };
}
export function summarizeStarsAmount(amount) {
    const a = amount;
    return { amount: a.amount.toString(), nanos: a.nanos };
}
export function summarizeStarsTransactionPeer(peer) {
    if (peer instanceof Api.StarsTransactionPeerAppStore)
        return { kind: "appStore" };
    if (peer instanceof Api.StarsTransactionPeerPlayMarket)
        return { kind: "playMarket" };
    if (peer instanceof Api.StarsTransactionPeerPremiumBot)
        return { kind: "premiumBot" };
    if (peer instanceof Api.StarsTransactionPeerFragment)
        return { kind: "fragment" };
    if (peer instanceof Api.StarsTransactionPeerAds)
        return { kind: "ads" };
    if (peer instanceof Api.StarsTransactionPeerAPI)
        return { kind: "api" };
    if (peer instanceof Api.StarsTransactionPeer)
        return { kind: "peer", peer: peerToCompact(peer.peer) };
    return { kind: "unsupported" };
}
export function summarizeStarsTransaction(tx) {
    const t = tx;
    return {
        id: t.id,
        stars: summarizeStarsAmount(t.stars),
        date: t.date,
        peer: summarizeStarsTransactionPeer(t.peer),
        refund: t.refund,
        pending: t.pending,
        failed: t.failed,
        gift: t.gift,
        reaction: t.reaction,
        title: t.title,
        description: t.description,
        msgId: t.msgId,
        subscriptionPeriod: t.subscriptionPeriod,
        giveawayPostId: t.giveawayPostId,
        transactionDate: t.transactionDate,
        transactionUrl: t.transactionUrl,
    };
}
export function summarizeStarsSubscription(sub) {
    const s = sub;
    const pricing = s.pricing;
    return {
        id: s.id,
        peer: peerToCompact(s.peer),
        untilDate: s.untilDate,
        pricing: { period: pricing.period, amount: pricing.amount.toString() },
        canceled: s.canceled,
        canRefulfill: s.canRefulfill,
        missingBalance: s.missingBalance,
        botCanceled: s.botCanceled,
        chatInviteHash: s.chatInviteHash,
        title: s.title,
        invoiceSlug: s.invoiceSlug,
    };
}
export function summarizeQuickReply(reply) {
    const r = reply;
    return {
        shortcutId: r.shortcutId,
        shortcut: r.shortcut,
        topMessage: r.topMessage,
        count: r.count,
    };
}
export function summarizeQuickReplies(result) {
    if (result instanceof Api.messages.QuickRepliesNotModified) {
        return { notModified: true };
    }
    const r = result;
    return { quickReplies: r.quickReplies.map(summarizeQuickReply) };
}
export function summarizeQuickReplyMessage(msg) {
    if (msg instanceof Api.MessageEmpty)
        return null;
    const base = msg;
    const fromId = peerToCompact(base.fromId);
    const replyHeader = base.replyTo;
    const replyToMsgId = replyHeader instanceof Api.MessageReplyHeader ? replyHeader.replyToMsgId : undefined;
    if (msg instanceof Api.Message) {
        return {
            id: msg.id,
            date: msg.date,
            text: fisMessageText(msg),  // Telegram MCP Starter (R4b)
            ...fisRichFlag(msg),
            isService: false,
            fromId,
            replyToMsgId,
        };
    }
    if (msg instanceof Api.MessageService) {
        return {
            id: msg.id,
            date: msg.date,
            text: `[${msg.action?.className ?? "service"}]`,
            isService: true,
            fromId,
        };
    }
    return null;
}
export function summarizeQuickReplyMessages(result) {
    if (result instanceof Api.messages.MessagesNotModified) {
        return { notModified: true, count: result.count };
    }
    const rawMessages = result
        .messages;
    const messages = rawMessages.map(summarizeQuickReplyMessage).filter((m) => m !== null);
    const count = result instanceof Api.messages.Messages
        ? messages.length
        : result.count;
    return { count, messages };
}
export function summarizeStarsStatus(result) {
    const r = result;
    const out = {
        balance: summarizeStarsAmount(r.balance),
        subscriptionsNextOffset: r.subscriptionsNextOffset || undefined,
        subscriptionsMissingBalance: r.subscriptionsMissingBalance?.toString(),
        nextOffset: r.nextOffset || undefined,
    };
    if (r.subscriptions && r.subscriptions.length > 0) {
        out.subscriptions = r.subscriptions.map(summarizeStarsSubscription);
    }
    if (r.history && r.history.length > 0) {
        out.history = r.history.map(summarizeStarsTransaction);
    }
    return out;
}
export function summarizeStoryItem(item) {
    if (item instanceof Api.StoryItemDeleted) {
        return { id: item.id, kind: "deleted" };
    }
    if (item instanceof Api.StoryItemSkipped) {
        return {
            id: item.id,
            kind: "skipped",
            date: item.date,
            expireDate: item.expireDate,
            closeFriends: item.closeFriends,
        };
    }
    const story = item;
    return {
        id: story.id,
        kind: "active",
        date: story.date,
        expireDate: story.expireDate,
        caption: story.caption,
        mediaType: story.media?.className,
        pinned: story.pinned,
        public: story.public,
        closeFriends: story.closeFriends,
        edited: story.edited,
        noforwards: story.noforwards,
        fromId: peerToCompact(story.fromId),
        viewsCount: story.views?.viewsCount,
        reactionsCount: story.views?.reactionsCount,
    };
}
export function summarizePeerStories(ps) {
    const peer = peerToCompact(ps.peer);
    if (!peer)
        return null;
    return {
        peer,
        maxReadId: ps.maxReadId,
        stories: (ps.stories ?? []).map(summarizeStoryItem),
    };
}
export function summarizeStoriesById(result) {
    return {
        count: result.count,
        stories: (result.stories ?? []).map(summarizeStoryItem),
        pinnedToTop: result.pinnedToTop,
    };
}
export function summarizeStoryView(view) {
    if (view instanceof Api.StoryViewPublicForward) {
        const msg = view.message;
        const messageId = msg instanceof Api.MessageEmpty ? undefined : msg?.id;
        const peer = msg instanceof Api.MessageEmpty
            ? undefined
            : peerToCompact(msg?.peerId);
        return {
            kind: "publicForward",
            messageId,
            peer,
            blocked: view.blocked,
            blockedMyStoriesFrom: view.blockedMyStoriesFrom,
        };
    }
    if (view instanceof Api.StoryViewPublicRepost) {
        const story = view.story;
        return {
            kind: "publicRepost",
            peer: peerToCompact(view.peerId),
            storyId: story?.id,
            blocked: view.blocked,
            blockedMyStoriesFrom: view.blockedMyStoriesFrom,
        };
    }
    const v = view;
    return {
        kind: "user",
        userId: v.userId.toString(),
        date: v.date,
        reaction: v.reaction ? reactionToEmoji(v.reaction) : undefined,
        blocked: v.blocked,
        blockedMyStoriesFrom: v.blockedMyStoriesFrom,
    };
}
export function summarizeStoryViewsList(result) {
    const list = result;
    return {
        count: list.count,
        viewsCount: list.viewsCount,
        forwardsCount: list.forwardsCount,
        reactionsCount: list.reactionsCount,
        views: (list.views ?? []).map(summarizeStoryView),
        nextOffset: list.nextOffset,
    };
}
export function detectMediaType(filePath) {
    const ext = filePath.toLowerCase().split(".").pop() ?? "";
    if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(ext))
        return "photo";
    return "video";
}
export function buildStoryPrivacyRules(privacy, allowUserIds, disallowUserIds) {
    const rules = [];
    switch (privacy) {
        case "everyone":
            rules.push(new Api.InputPrivacyValueAllowAll());
            break;
        case "contacts":
            rules.push(new Api.InputPrivacyValueAllowContacts());
            break;
        case "close_friends":
            rules.push(new Api.InputPrivacyValueAllowCloseFriends());
            break;
        case "selected":
            rules.push(new Api.InputPrivacyValueAllowUsers({
                users: (allowUserIds ?? []).map((id) => new Api.InputUser({ userId: bigInt(id), accessHash: bigInt(0) })),
            }));
            break;
    }
    if (disallowUserIds?.length && privacy !== "selected") {
        rules.push(new Api.InputPrivacyValueDisallowUsers({
            users: disallowUserIds.map((id) => new Api.InputUser({ userId: bigInt(id), accessHash: bigInt(0) })),
        }));
    }
    return rules;
}
export function extractStoryIdFromUpdates(result) {
    if (!result)
        return 0;
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
        for (const u of result.updates) {
            if (u instanceof Api.UpdateStoryID)
                return u.id;
        }
        for (const u of result.updates) {
            if (u instanceof Api.UpdateStory && u.story instanceof Api.StoryItem)
                return u.story.id;
        }
    }
    return 0;
}
export function summarizeDiscussionMessage(result) {
    const topMsg = result.messages?.[0];
    let discussionGroupId = "";
    for (const chat of result.chats ?? []) {
        const isBroadcast = "broadcast" in chat && chat.broadcast;
        if (!isBroadcast) {
            discussionGroupId = `-100${chat.id.toString()}`;
            break;
        }
    }
    const discussionMsgId = topMsg instanceof Api.Message || topMsg instanceof Api.MessageService ? topMsg.id : 0;
    const topMessage = topMsg instanceof Api.Message
        ? {
            id: topMsg.id,
            text: topMsg.message?.slice(0, 200),
            date: topMsg.date,
        }
        : undefined;
    return {
        discussionGroupId,
        discussionMsgId,
        unreadCount: result.unreadCount ?? 0,
        readInboxMaxId: result.readInboxMaxId,
        readOutboxMaxId: result.readOutboxMaxId,
        topMessage,
    };
}
export function summarizeGroupsForDiscussion(result) {
    const chats = "chats" in result ? result.chats : [];
    return {
        groups: chats.map((c) => {
            const id = `-100${c.id.toString()}`;
            const title = "title" in c ? c.title : "";
            const username = "username" in c ? (c.username ?? undefined) : undefined;
            const participantsCount = "participantsCount" in c ? (c.participantsCount ?? undefined) : undefined;
            return { id, title, username, participantsCount };
        }),
    };
}
export function summarizeReadParticipants(list, messageId) {
    return {
        messageId,
        readers: list.map((r) => ({
            userId: r.userId.toString(),
            readAt: new Date(r.date * 1000).toISOString(),
        })),
        count: list.length,
    };
}
export function summarizeReportResult(result) {
    if (result instanceof Api.ReportResultReported)
        return { kind: "reported" };
    if (result instanceof Api.ReportResultAddComment)
        return { kind: "addComment", optional: result.optional };
    if (result instanceof Api.ReportResultChooseOption) {
        return {
            kind: "chooseOption",
            title: result.title,
            options: (result.options ?? []).map((o) => {
                const opt = o;
                return {
                    text: opt.text,
                    option: Buffer.from(opt.option).toString("base64"),
                };
            }),
        };
    }
    throw new Error(`unknown ReportResult type: ${result.className ?? "unknown"}`);
}
export function summarizePoll(poll, results) {
    const total = results?.totalVoters ?? 0;
    const answerResults = results?.results ?? [];
    const options = poll.answers.map((answer, index) => {
        // Match by option bytes
        const v = answerResults.find((r) => {
            const rOpt = Buffer.from(r.option);
            const aOpt = Buffer.from(answer.option);
            return rOpt.equals(aOpt);
        });
        const votes = v?.voters ?? 0;
        const percent = total > 0 ? Math.round((votes / total) * 1000) / 10 : 0;
        return {
            index,
            text: answer.text.text,
            votes,
            percent,
            chosen: v?.chosen ?? false,
            correct: poll.quiz ? (v?.correct ?? false) : undefined,
        };
    });
    return {
        question: poll.question.text,
        isClosed: poll.closed ?? false,
        isQuiz: poll.quiz ?? false,
        isMulti: poll.multipleChoice ?? false,
        totalVoters: total,
        options,
    };
}
export function extractPollMediaFromUpdates(updates) {
    let list = [];
    if (updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined) {
        list = updates.updates;
    }
    else if (updates instanceof Api.UpdateShort) {
        list = [updates.update];
    }
    for (const u of list) {
        if (u instanceof Api.UpdateMessagePoll) {
            if (u.poll instanceof Api.Poll) {
                return {
                    poll: u.poll,
                    results: u.results instanceof Api.PollResults ? u.results : undefined,
                };
            }
        }
    }
    return null;
}
export function extractPeerId(peer) {
    if (peer instanceof Api.PeerUser)
        return peer.userId.toString();
    if (peer instanceof Api.PeerChat)
        return peer.chatId.toString();
    if (peer instanceof Api.PeerChannel)
        return peer.channelId.toString();
    return "0";
}
export function summarizeEmojiStatus(s) {
    if (s instanceof Api.EmojiStatusCollectible) {
        return {
            kind: "collectible",
            collectibleId: s.collectibleId.toString(),
            documentId: s.documentId?.toString(),
            title: s.title,
            slug: s.slug,
            until: s.until,
        };
    }
    if (s instanceof Api.EmojiStatus) {
        return { kind: "default", documentId: s.documentId.toString(), until: s.until };
    }
    return { kind: "empty" };
}
export function summarizePeer(peer) {
    if (peer instanceof Api.PeerUser)
        return { id: peer.userId.toString(), type: "user" };
    if (peer instanceof Api.PeerChat)
        return { id: peer.chatId.toString(), type: "chat" };
    return { id: peer.channelId.toString(), type: "channel" };
}
export function summarizeAllStories(result) {
    const stealthMode = result.stealthMode
        ? {
            activeUntilDate: result.stealthMode.activeUntilDate,
            cooldownUntilDate: result.stealthMode.cooldownUntilDate,
        }
        : undefined;
    if (result instanceof Api.stories.AllStoriesNotModified) {
        return {
            modified: false,
            state: result.state,
            peerStories: [],
            stealthMode,
        };
    }
    const all = result;
    const peerStories = (all.peerStories ?? [])
        .map(summarizePeerStories)
        .filter((p) => p !== null);
    return {
        modified: true,
        state: all.state,
        hasMore: all.hasMore,
        count: all.count,
        peerStories,
        stealthMode,
    };
}
