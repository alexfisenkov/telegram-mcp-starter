import { TelegramClient } from "telegram";
import { Api } from "telegram/tl/index.js";
import type { AllStoriesSummary, BoostsListSummary, BoostsStatusSummary, BroadcastStatsSummary, BusinessChatLinksSummary, ChannelDifferenceSummary, ChatPermissions, DiscussionMessageSummary, EmojiStatusSummary, GroupCallParticipantsSummary, GroupCallSummary, GroupsForDiscussionSummary, MegagroupStatsSummary, MessageButtonDescriptor, MyBoostsSummary, PeerStoriesSummary, PollSummary, QuickRepliesSummary, QuickReplyMessagesSummary, ReadParticipantsSummary, ReportResultSummary, ResolvedBusinessChatLinkSummary, SavedMusicSummary, StarsStatusSummary, StoriesByIdSummary, StoryPrivacy, StoryViewsListSummary, UpdatesDifferenceSummary } from "./telegram-helpers.js";
export type { AllStoriesSummary, BoostSummary, BoostsListSummary, BoostsStatusSummary, BroadcastStatsSummary, BusinessChatLinkSummary, BusinessChatLinksSummary, ChannelDifferenceSummary, ChatPermissions, CompactPeer, CompactStatsGraph, DiscussionMessageSummary, EmojiStatusSummary, GroupCallInfoSummary, GroupCallParticipantSummary, GroupCallParticipantsSummary, GroupCallSummary, GroupsForDiscussionSummary, MegagroupStatsSummary, MessageButtonDescriptor, MyBoostSummary, MyBoostsSummary, PeerStoriesSummary, PeerSummary, PollSummary, PrepaidGiveawaySummary, QuickRepliesSummary, QuickReplyMessageSummary, QuickReplyMessagesSummary, QuickReplySummary, ReadParticipantsSummary, ReportResultSummary, ResolvedBusinessChatLinkSummary, SavedMusicSummary, SavedMusicTrack, StarsAmountSummary, StarsStatusSummary, StarsSubscriptionPricingSummary, StarsSubscriptionSummary, StarsTransactionPeerSummary, StarsTransactionSummary, StatsValue, StoriesByIdSummary, StoryItemSummary, StoryPrivacy, StoryViewSummary, StoryViewsListSummary, UpdatesDifferenceSummary, UpdatesMessageSummary, } from "./telegram-helpers.js";
export { buildStoryPrivacyRules, describeAdminLogAction, describeAdminLogDetails, describeKeyboardButton, detectMediaType, extractPeerId, extractPollMediaFromUpdates, extractStoryIdFromUpdates, mergeBannedRights, peerToCompact, reactionToEmoji, summarizeAllStories, summarizeBoost, summarizeBoostsList, summarizeBoostsStatus, summarizeBroadcastStats, summarizeBusinessChatLink, summarizeBusinessChatLinks, summarizeChannelDifference, summarizeDiscussionMessage, summarizeEmojiStatus, summarizeGroupCall, summarizeGroupCallInfo, summarizeGroupCallParticipant, summarizeGroupCallParticipants, summarizeGroupsForDiscussion, summarizeMegagroupStats, summarizeMyBoost, summarizeMyBoosts, summarizePeer, summarizePeerStories, summarizePoll, summarizePrepaidGiveaway, summarizeQuickReplies, summarizeQuickReply, summarizeQuickReplyMessage, summarizeQuickReplyMessages, summarizeReadParticipants, summarizeReportResult, summarizeSavedMusic, summarizeStarsAmount, summarizeStarsStatus, summarizeStarsSubscription, summarizeStarsTransaction, summarizeStarsTransactionPeer, summarizeStoriesById, summarizeStoryItem, summarizeStoryView, summarizeStoryViewsList, summarizeUpdatesDifference, } from "./telegram-helpers.js";
/** Minimal client surface the 2FA SRP step needs — lets us unit-test the
 *  branch logic with a stub instead of a live TelegramClient. */
interface SrpClient {
    invoke(request: unknown): Promise<unknown>;
}
/** The SRP digest function (GetPassword response + plaintext → InputCheckPasswordSRP).
 *  Injectable so tests can exercise the orchestration without GramJS's real crypto. */
type ComputeCheckFn = (request: Api.account.Password, password: string) => Promise<Api.TypeInputCheckPasswordSRP>;
/**
 * Complete a QR login that Telegram answered with SESSION_PASSWORD_NEEDED by
 * running the SRP cloud-password check: GetPassword → computeCheck → CheckPassword.
 *
 * Returns a discriminated outcome rather than throwing so the caller owns
 * connection teardown. The password is only used to answer the SRP challenge
 * and is never logged or persisted.
 *
 * `compute` is injectable for tests; production always uses GramJS `computeCheck`.
 */
export declare function completeTwoFactorLogin(client: SrpClient, password: string | undefined, compute?: ComputeCheckFn): Promise<{
    ok: true;
} | {
    ok: false;
    message: string;
}>;
export type ChatEntity = Api.User | Api.Chat | Api.Channel | Api.TypeUser | Api.TypeChat;
export declare class TelegramService {
    private client;
    private apiId;
    private apiHash;
    private sessionString;
    private connected;
    private sessionPath;
    private rateLimiter;
    private lastTypingAt;
    private entityCache;
    lastError: string;
    get sessionDir(): string;
    hasLocalSession(): boolean;
    getClient(): TelegramClient | null;
    constructor(apiId: number, apiHash: string, options?: {
        sessionPath?: string;
    });
    loadSession(): Promise<boolean>;
    private isValidSessionString;
    /** Set session string in memory (for programmatic / hosted use) */
    setSessionString(session: string): void;
    /** Get the current session string (for external persistence) */
    getSessionString(): string;
    private saveSession;
    /**
     * True when our sticky `connected` flag disagrees with GramJS about the live transport.
     *
     * `this.connected` is set in connect() and cleared only by disconnect()/clearSession()/
     * logOut() — never when the MTProto socket dies. So once GramJS exhausts its
     * `connectionRetries` budget the flag stays true, ensureConnected() keeps returning true,
     * and every tool call is issued on a dead client and hangs forever (issue #71).
     *
     * GramJS exposes the real state via `get connected()` -> `_sender && _sender.isConnected()`.
     * Only an explicit `false` counts as dead — deliberately not "any non-true value". The
     * getter yields `undefined` when there is no sender yet, and a GramJS upgrade that renamed
     * or dropped the property would read as `undefined` too; under a `!== true` test that would
     * tear down and rebuild the client on every single call, a reconnect storm worse than the
     * bug being fixed. With `=== false` an unknown signal degrades to the old behaviour, while
     * the reported failure (sender present, transport down) still reads `false` and recovers.
     */
    private isTransportDead;
    /**
     * Tear down a client whose transport is gone so connect() can rebuild from the saved
     * session. This is the in-process equivalent of killing the master: same session string,
     * fresh sender. No-op when there is no client.
     */
    private dropDeadClient;
    /**
     * Force the next ensureConnected() to revalidate instead of trusting the cached flag.
     * Called when a caller observed a symptom the flag can't see (e.g. a tool call that hung
     * past its budget), so recovery doesn't have to wait for GramJS to notice.
     */
    markUnhealthy(reason: string): void;
    connect(): Promise<boolean>;
    clearSession(): Promise<void>;
    /** Ensure connection is active, auto-reconnect if session exists */
    ensureConnected(): Promise<boolean>;
    disconnect(): Promise<void>;
    /**
     * Terminates the session on Telegram servers, destroys the client, and clears
     * local session (in-memory + file). Returns true only when server-side revoke
     * confirmed. False means server revoke could not be confirmed — local wipe
     * was still attempted. Throws if local file removal failed so callers can
     * surface the partial state instead of silently misreporting success.
     */
    logOut(): Promise<boolean>;
    isConnected(): boolean;
    startQrLogin(onQrDataUrl: (dataUrl: string) => void, onQrUrl?: (url: string) => void, signal?: AbortSignal): Promise<{
        success: boolean;
        message: string;
    }>;
    getMe(): Promise<{
        id: string;
        username?: string;
        firstName?: string;
    }>;
    sendMessage(chatId: string, text: string, replyTo?: number, parseMode?: "md" | "html", topicId?: number, extra?: {
        quoteText?: string;
        effect?: string;
    }): Promise<Api.Message | Api.UpdateShortSentMessage | undefined>;
    /** Telegram MCP Starter M10: verified video metadata plus stable messageId for reply/read-back. */
    sendFile(chatId: string, filePath: string, caption?: string, onProgress?: (progress: number, total?: number) => void): Promise<{
        id: number;
        messageId: number;
        type: "video" | "file";
        size: number;
        width?: number;
        height?: number;
        duration?: number;
        supportsStreaming?: boolean;
    }>;
    sendVoice(chatId: string, filePath: string, opts?: {
        caption?: string;
        replyTo?: number;
        topicId?: number;
        parseMode?: "md" | "html";
        /** Original name of the audio. GramJS sniffs the codec from the name, so an
         * extension-less temp path yields `application/octet-stream` and no
         * DocumentAttributeAudio. See sendFile for the full rationale. */
        fileName?: string;
    }): Promise<{
        id: number;
    }>;
    sendVideoNote(chatId: string, filePath: string, opts?: {
        duration?: number;
        length?: number;
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        id: number;
    }>;
    sendContact(chatId: string, phone: string, firstName: string, opts?: {
        lastName?: string;
        vcard?: string;
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        id: number;
    }>;
    sendDice(chatId: string, emoji: string, opts?: {
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        id: number;
        value?: number;
    }>;
    sendLocation(chatId: string, latitude: number, longitude: number, opts?: {
        accuracyRadius?: number;
        livePeriod?: number;
        heading?: number;
        proximityRadius?: number;
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        id: number;
    }>;
    sendVenue(chatId: string, latitude: number, longitude: number, title: string, address: string, opts?: {
        provider?: string;
        venueId?: string;
        venueType?: string;
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        id: number;
    }>;
    sendAlbum(chatId: string, items: Array<{
        filePath: string;
        caption?: string;
        fileName?: string;
    }>, opts?: {
        caption?: string;
        parseMode?: "md" | "html";
        replyTo?: number;
        topicId?: number;
    }): Promise<{
        ids: number[];
    }>;
    downloadMedia(chatId: string, messageId: number, downloadPath: string): Promise<string>;
    /**
     * Download a message's media into memory.
     *
     * When `options.thumb` is given, GramJS fetches that thumbnail size instead of
     * the full file (`0` = smallest, larger indexes = bigger previews). This keeps
     * payloads tiny — useful for callers that inline the bytes and pay per byte
     * (e.g. base64 in an LLM context). If the message has no thumbnail at that
     * index, GramJS returns an empty/`undefined` buffer; we transparently fall
     * back to the full file so the caller always gets bytes. `isThumb` reports
     * which one was served.
     *
     * Note: GramJS signals "no bytes" inconsistently — `undefined` for a missing
     * thumbnail, but `Buffer.alloc(0)` for undownloadable media (geo/poll/dice,
     * documents without a file, and several failure paths). An empty Buffer is
     * truthy, so we guard on `.length`, not truthiness, in both the fallback and
     * the final failure check — otherwise a 0-byte buffer would be returned as a
     * "successful" (but garbage) download.
     */
    downloadMediaAsBuffer(chatId: string, messageId: number, options?: {
        thumb?: number;
    }): Promise<{
        buffer: Buffer;
        mimeType: string;
        isThumb: boolean;
    }>;
    /** Detect MIME type from buffer magic bytes, falling back to media metadata */
    private detectMimeType;
    pinMessage(chatId: string, messageId: number, silent?: boolean): Promise<void>;
    unpinMessage(chatId: string, messageId: number): Promise<void>;
    getDialogs(limit?: number, offsetDate?: number, filterType?: "private" | "group" | "channel" | "contact_requests"): Promise<Array<{
        id: string;
        name: string;
        type: string;
        unreadCount: number;
        isBot?: boolean;
        isContact?: boolean;
    }>>;
    getUnreadDialogs(limit?: number): Promise<Array<{
        id: string;
        name: string;
        type: string;
        unreadCount: number;
        isBot?: boolean;
        isContact?: boolean;
        forum?: boolean;
        topics?: Array<{
            id: number;
            title: string;
            unreadCount: number;
        }>;
    }>>;
    getContactRequests(limit?: number): Promise<Array<{
        id: string;
        name: string;
        username?: string;
        isBot: boolean;
        unreadCount: number;
        lastMessage?: string;
        lastMessageDate?: number;
    }>>;
    addContact(userId: string, firstName: string, lastName?: string, phone?: string): Promise<void>;
    blockUser(userId: string): Promise<void>;
    reportSpam(chatId: string): Promise<void>;
    markAsRead(chatId: string): Promise<void>;
    getMessageById(chatId: string, messageId: number): Promise<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    } | null>;
    forwardMessage(fromChatId: string, toChatId: string, messageIds: number[]): Promise<void>;
    editMessage(chatId: string, messageId: number, newText: string): Promise<void>;
    deleteMessages(chatId: string, messageIds: number[]): Promise<void>;
    getScheduledMessages(chatId: string): Promise<Array<{
        id: number;
        date: string;
        text: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
    }>>;
    deleteScheduledMessages(chatId: string, messageIds: number[]): Promise<void>;
    getReplies(chatId: string, messageId: number, limit?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    getMessageLink(chatId: string, messageId: number, thread?: boolean): Promise<string>;
    getUnreadMentions(chatId: string, limit?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    getUnreadReactions(chatId: string, limit?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    translateText(chatId: string, messageIds: number[], toLang: string): Promise<string[]>;
    sendTyping(chatId: string, action?: "typing" | "upload_photo" | "upload_document" | "cancel"): Promise<void>;
    /**
     * Resolve a chat by ID, username, or display name.
     * Falls back to searching user's dialogs if getEntity() fails.
     */
    resolveChat(chatId: string): Promise<ChatEntity>;
    /**
     * Resolve chatId to a peer string that GramJS methods accept.
     * Handles display names by searching dialogs.
     */
    private resolvePeer;
    /**
     * Resolve a bare numeric ID to a cached/dialog entity so GramJS can build a
     * valid InputPeer. Falls back to the raw ID string if no dialog matches —
     * GramJS may still resolve it (e.g. a contact or a peer it has messaged),
     * and we must not regress that path.
     */
    private resolveNumericPeer;
    getChatInfo(chatId: string): Promise<{
        id: string;
        name: string;
        type: string;
        username?: string;
        description?: string;
        membersCount?: number;
        isBot?: boolean;
        isContact?: boolean;
        forum?: boolean;
    }>;
    /** Extract media info from a message */
    private extractMediaInfo;
    /** Resolve sender ID to a display name */
    private resolveSenderName;
    getMessages(chatId: string, limit?: number, offsetId?: number, minDate?: number, maxDate?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    searchChats(query: string, limit?: number): Promise<Array<{
        id: string;
        name: string;
        type: string;
        username?: string;
        membersCount?: number;
        description?: string;
    }>>;
    searchGlobal(query: string, limit?: number, minDate?: number, maxDate?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        chat: {
            id: string;
            name: string;
            type: string;
            username?: string;
        };
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    searchMessages(chatId: string, query: string, limit?: number, minDate?: number, maxDate?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    getContacts(limit?: number): Promise<Array<{
        id: string;
        name: string;
        username?: string;
        phone?: string;
    }>>;
    getChatMembers(chatId: string, limit?: number): Promise<Array<{
        id: string;
        name: string;
        username?: string;
        role: string;
    }>>;
    getMyRole(chatId: string): Promise<{
        role: string;
        chatId: string;
        chatName: string;
    }>;
    private getParticipantUserId;
    private getParticipantRole;
    getProfile(userId: string): Promise<{
        id: string;
        name: string;
        username?: string;
        phone?: string;
        bio?: string;
        photo: boolean;
        lastSeen?: string;
        premium?: boolean;
        birthday?: string;
        commonChatsCount?: number;
        personalChannelId?: string;
        businessWorkHours?: string;
        businessLocation?: string;
    }>;
    /**
     * List the songs pinned to a user's profile (`users.getSavedMusic`).
     *
     * The request class is hand-rolled (`./tl/saved-music.ts`) because GramJS is pinned at TL
     * layer 198, which predates this method.
     */
    getSavedMusic(userId?: string, opts?: {
        offset?: number;
        limit?: number;
    }): Promise<SavedMusicSummary>;
    downloadProfilePhoto(entityId: string, options?: {
        isBig?: boolean;
        savePath?: string;
    }): Promise<{
        buffer: Buffer;
        mimeType: string;
    } | {
        filePath: string;
    } | null>;
    /** Detect MIME type from buffer magic bytes */
    private detectMimeFromBuffer;
    /** Extract reactions from a message into a simple format */
    private extractReactions;
    sendReaction(chatId: string, messageId: number, emoji?: string | string[], addToExisting?: boolean): Promise<{
        emoji: string;
        count: number;
        me: boolean;
    }[] | undefined>;
    getMessageReactions(chatId: string, messageId: number): Promise<{
        reactions: {
            emoji: string;
            count: number;
            users: {
                id: string;
                name: string;
            }[];
        }[];
        total: number;
    }>;
    setDefaultReaction(emoji: string): Promise<void>;
    getTopReactions(limit: number): Promise<Array<{
        emoji: string;
    }>>;
    getRecentReactions(limit: number): Promise<Array<{
        emoji: string;
    }>>;
    sendScheduledMessage(chatId: string, text: string, scheduleDate: number, replyTo?: number, parseMode?: "md" | "html"): Promise<void>;
    createPoll(chatId: string, question: string, answers: string[], options?: {
        multipleChoice?: boolean;
        quiz?: boolean;
        correctAnswer?: number;
    }): Promise<number>;
    sendPollVote(chatId: string, messageId: number, optionIndexes: number[]): Promise<{
        totalVoters: number;
        chosenLabels: string[];
        isRetracted: boolean;
    }>;
    getPollResults(chatId: string, messageId: number): Promise<PollSummary>;
    getPollVoters(chatId: string, messageId: number, opts?: {
        optionIndex?: number;
        limit?: number;
        offset?: string;
    }): Promise<{
        total: number;
        nextOffset?: string;
        voters: Array<{
            peerId: string;
            name?: string;
            username?: string;
            options: string[];
            date: number;
        }>;
    }>;
    closePoll(chatId: string, messageId: number): Promise<{
        totalVoters: number;
    }>;
    transcribeAudio(chatId: string, messageId: number): Promise<{
        transcriptionId: string;
        text: string;
        pending: boolean;
        trialRemainsNum?: number;
        trialRemainsUntilDate?: number;
    }>;
    rateTranscription(chatId: string, messageId: number, transcriptionId: string, good: boolean): Promise<void>;
    getFactCheck(chatId: string, messageIds: number[]): Promise<Array<{
        messageId: number;
        needCheck: boolean;
        country?: string;
        text?: string;
        hash: string;
    }>>;
    editFactCheck(chatId: string, messageId: number, text: string, _opts?: {
        parseMode?: "md" | "html";
    }): Promise<void>;
    deleteFactCheck(chatId: string, messageId: number): Promise<void>;
    sendPaidReaction(chatId: string, messageId: number, count: number, opts?: {
        private?: boolean;
    }): Promise<{
        count: number;
    }>;
    togglePaidReactionPrivacy(chatId: string, messageId: number, privateFlag: boolean): Promise<void>;
    getPaidReactionPrivacy(): Promise<{
        private: boolean;
    }>;
    getForumTopics(chatId: string, limit?: number): Promise<Array<{
        id: number;
        title: string;
        unreadCount: number;
        unreadMentions: number;
        iconColor: number;
        iconEmojiId?: string;
        closed: boolean;
        hidden: boolean;
        pinned: boolean;
    }>>;
    getTopicMessages(chatId: string, topicId: number, limit?: number, offsetId?: number): Promise<Array<{
        id: number;
        text: string;
        sender: string;
        date: string;
        media?: {
            type: string;
            fileName?: string;
            size?: number;
        };
        reactions?: {
            emoji: string;
            count: number;
            me: boolean;
        }[];
    }>>;
    /** Check if a chat entity is a forum (has topics enabled) */
    isForum(chatId: string): Promise<boolean>;
    joinChat(target: string): Promise<{
        id: string;
        title: string;
        type: string;
    }>;
    createGroup(options: {
        title: string;
        users: string[];
        supergroup?: boolean;
        forum?: boolean;
        description?: string;
    }): Promise<{
        id: string;
        title: string;
        type: string;
        inviteLink?: string;
        missingInvitees?: string[];
    }>;
    inviteToGroup(chatId: string, users: string[]): Promise<{
        invited: string[];
        failed: string[];
    }>;
    kickUser(chatId: string, userId: string): Promise<void>;
    banUser(chatId: string, userId: string): Promise<void>;
    unbanUser(chatId: string, userId: string): Promise<void>;
    editGroup(chatId: string, options: {
        title?: string;
        description?: string;
        photoPath?: string;
    }): Promise<void>;
    leaveGroup(chatId: string): Promise<void>;
    setAdmin(chatId: string, userId: string, options?: {
        title?: string;
    }): Promise<void>;
    removeAdmin(chatId: string, userId: string): Promise<void>;
    unblockUser(userId: string): Promise<void>;
    muteChat(chatId: string, muteUntil: number): Promise<void>;
    archiveChat(chatId: string, archive: boolean): Promise<void>;
    pinDialog(chatId: string, pin: boolean): Promise<void>;
    markDialogUnread(chatId: string, unread: boolean): Promise<void>;
    getAdminLog(chatId: string, limit?: number, q?: string): Promise<Array<{
        id: string;
        date: string;
        userId: string;
        userName: string;
        action: string;
        details: string;
    }>>;
    setChatPermissions(chatId: string, permissions: ChatPermissions): Promise<void>;
    setSlowMode(chatId: string, seconds: number): Promise<void>;
    toggleChannelSignatures(chatId: string, enabled: boolean): Promise<void>;
    toggleAntiSpam(chatId: string, enabled: boolean): Promise<void>;
    toggleForumMode(chatId: string, enabled: boolean): Promise<void>;
    togglePrehistoryHidden(chatId: string, hidden: boolean): Promise<void>;
    setChatAvailableReactions(chatId: string, reactions: {
        type: "all";
        allowCustom?: boolean;
    } | {
        type: "some";
        emoji: string[];
    } | {
        type: "none";
    }): Promise<void>;
    approveChatJoinRequest(chatId: string, userId: string, approved: boolean): Promise<void>;
    getInlineBotResults(bot: string, chatId: string, query: string, offset?: string): Promise<{
        queryId: string;
        nextOffset?: string;
        cacheTime: number;
        gallery: boolean;
        results: Array<{
            id: string;
            type: string;
            title?: string;
            description?: string;
            url?: string;
        }>;
    }>;
    sendInlineBotResult(chatId: string, queryId: string, resultId: string, options?: {
        replyTo?: number;
        silent?: boolean;
        hideVia?: boolean;
        clearDraft?: boolean;
    }): Promise<{
        messageId: number;
    }>;
    pressButton(chatId: string, messageId: number, options: {
        buttonIndex?: {
            row: number;
            column: number;
        };
        data?: string;
    }): Promise<{
        alert?: boolean;
        hasUrl?: boolean;
        nativeUi?: boolean;
        message?: string;
        url?: string;
        cacheTime: number;
    }>;
    getMessageButtons(chatId: string, messageId: number): Promise<{
        markupType: string;
        buttons: MessageButtonDescriptor[];
    }>;
    getBroadcastStats(chatId: string, options?: {
        dark?: boolean;
        includeGraphs?: boolean;
    }): Promise<BroadcastStatsSummary>;
    getMegagroupStats(chatId: string, options?: {
        dark?: boolean;
        includeGraphs?: boolean;
    }): Promise<MegagroupStatsSummary>;
    getUpdatesState(): Promise<{
        pts: number;
        qts: number;
        date: number;
        seq: number;
        unreadCount: number;
    }>;
    getUpdates(cursor: {
        pts: number;
        date: number;
        qts: number;
        ptsLimit?: number;
        ptsTotalLimit?: number;
    }): Promise<UpdatesDifferenceSummary>;
    getChannelUpdates(chatId: string, cursor: {
        pts: number;
        limit?: number;
        force?: boolean;
    }): Promise<ChannelDifferenceSummary>;
    createForumTopic(chatId: string, title: string, iconColor?: number, iconEmojiId?: string): Promise<{
        id: number;
        title: string;
    }>;
    editForumTopic(chatId: string, topicId: number, options: {
        title?: string;
        iconEmojiId?: string;
        closed?: boolean;
        hidden?: boolean;
    }): Promise<void>;
    deleteForumTopic(chatId: string, topicId: number): Promise<void>;
    // Telegram MCP Starter (M14)
    pinForumTopic(chatId: string, topicId: number, pinned?: boolean): Promise<void>;
    reorderPinnedForumTopics(chatId: string, order: number[], force?: boolean): Promise<void>;
    // Telegram MCP Starter (M16)
    exportInviteLink(chatId: string, options?: {
        expireDate?: number;
        usageLimit?: number;
        requestNeeded?: boolean;
        title?: string;
        replacePrimary?: boolean;
    }): Promise<{
        link: string;
        title?: string;
        permanent: boolean;
        requestNeeded: boolean;
    }>;
    getInviteLinks(chatId: string, limit?: number, adminId?: string): Promise<Array<{
        link: string;
        title?: string;
        expired: boolean;
        revoked: boolean;
        usageCount: number;
        permanent: boolean;
        requestNeeded: boolean;
    }>>;
    revokeInviteLink(chatId: string, link: string): Promise<void>;
    getChatFolders(): Promise<Array<{
        id: number;
        title: string;
        emoticon?: string;
        pinnedCount: number;
        includeCount: number;
    }>>;
    setAutoDelete(chatId: string, period: number): Promise<void>;
    createFolder(opts: {
        title: string;
        emoticon?: string;
        contacts?: boolean;
        nonContacts?: boolean;
        groups?: boolean;
        broadcasts?: boolean;
        bots?: boolean;
        excludeMuted?: boolean;
        excludeRead?: boolean;
        excludeArchived?: boolean;
        includePeers?: string[];
        excludePeers?: string[];
        pinnedPeers?: string[];
    }): Promise<number>;
    editFolder(id: number, opts: {
        title?: string;
        emoticon?: string;
        contacts?: boolean;
        nonContacts?: boolean;
        groups?: boolean;
        broadcasts?: boolean;
        bots?: boolean;
        excludeMuted?: boolean;
        excludeRead?: boolean;
        excludeArchived?: boolean;
        includePeers?: string[];
        excludePeers?: string[];
        pinnedPeers?: string[];
    }): Promise<void>;
    deleteFolder(id: number): Promise<void>;
    reorderFolders(ids: number[]): Promise<void>;
    getSuggestedFolders(): Promise<Array<{
        title: string;
        emoticon?: string;
    }>>;
    toggleDialogFilterTags(enabled: boolean): Promise<void>;
    getGlobalPrivacySettings(): Promise<{
        archiveAndMuteNewNoncontactPeers: boolean;
        keepArchivedUnmuted: boolean;
        keepArchivedFolders: boolean;
        hideReadMarks: boolean;
        newNoncontactPeersRequirePremium: boolean;
    }>;
    setGlobalPrivacySettings(opts: {
        archiveAndMuteNewNoncontactPeers?: boolean;
        keepArchivedUnmuted?: boolean;
        keepArchivedFolders?: boolean;
        hideReadMarks?: boolean;
        newNoncontactPeersRequirePremium?: boolean;
    }): Promise<void>;
    getActiveSessions(): Promise<Array<{
        hash: string;
        device: string;
        platform: string;
        appName: string;
        appVersion: string;
        ip: string;
        country: string;
        dateActive: string;
        current: boolean;
    }>>;
    terminateSession(hash: string): Promise<void>;
    terminateAllOtherSessions(): Promise<void>;
    private static PRIVACY_KEYS;
    setPrivacy(setting: string, rule: "everyone" | "contacts" | "nobody", allowUsers?: string[], disallowUsers?: string[]): Promise<void>;
    updateProfile(options: {
        firstName?: string;
        lastName?: string;
        bio?: string;
    }): Promise<void>;
    updateUsername(username: string): Promise<void>;
    getStickerSet(shortName: string): Promise<{
        title: string;
        shortName: string;
        count: number;
        stickers: Array<{
            id: string;
            accessHash: string;
            emoji: string;
        }>;
    }>;
    searchStickerSets(query: string): Promise<Array<{
        title: string;
        shortName: string;
        count: number;
    }>>;
    getInstalledStickerSets(): Promise<Array<{
        title: string;
        shortName: string;
        count: number;
    }>>;
    sendSticker(chatId: string, stickerSetShortName: string, stickerIndex: number, replyTo?: number): Promise<Api.Message | Api.UpdateShortSentMessage | undefined>;
    saveDraft(chatId: string, text: string, replyTo?: number): Promise<void>;
    getAllDrafts(): Promise<Array<{
        chatId: string;
        chatTitle: string;
        text: string;
        date: string;
    }>>;
    clearAllDrafts(): Promise<void>;
    getSavedDialogs(limit: number): Promise<Array<{
        peerId: string;
        peerTitle: string;
        lastMsgId: number;
    }>>;
    getWebPreview(url: string): Promise<{
        type: string;
        url?: string;
        title?: string;
        description?: string;
        siteName?: string;
    } | null>;
    getRecentStickers(): Promise<Array<{
        id: string;
        accessHash: string;
        emoji: string;
    }>>;
    getAllStories(options?: {
        next?: boolean;
        hidden?: boolean;
        state?: string;
    }): Promise<AllStoriesSummary>;
    getPeerStories(chatId: string): Promise<PeerStoriesSummary | null>;
    getStoriesById(chatId: string, ids: number[]): Promise<StoriesByIdSummary>;
    getStoryViewsList(chatId: string, options: {
        id: number;
        q?: string;
        justContacts?: boolean;
        reactionsFirst?: boolean;
        forwardsFirst?: boolean;
        offset?: string;
        limit?: number;
    }): Promise<StoryViewsListSummary>;
    getMyBoosts(): Promise<MyBoostsSummary>;
    getBoostsStatus(chatId: string): Promise<BoostsStatusSummary>;
    getBoostsList(chatId: string, options?: {
        gifts?: boolean;
        offset?: string;
        limit?: number;
    }): Promise<BoostsListSummary>;
    getBusinessChatLinks(): Promise<BusinessChatLinksSummary>;
    setEmojiStatus(opts: {
        documentId?: string;
        collectibleId?: string;
        untilUnix?: number;
    }): Promise<void>;
    listEmojiStatuses(kind: "default" | "recent" | "channel_default" | "collectible", limit: number): Promise<EmojiStatusSummary[]>;
    clearRecentEmojiStatuses(): Promise<void>;
    setProfileColor(opts: {
        forProfile: boolean;
        color?: number;
        backgroundEmojiId?: string;
    }): Promise<void>;
    setBirthday(opts: {
        day?: number;
        month?: number;
        year?: number;
        clear?: boolean;
    }): Promise<void>;
    setPersonalChannel(opts: {
        channelId?: string;
        clear?: boolean;
    }): Promise<string | null>;
    setProfilePhoto(opts: {
        filePath: string;
        isVideo: boolean;
        videoStartTs?: number;
        fallback: boolean;
    }): Promise<{
        id: string;
    }>;
    deleteProfilePhotos(photoIds: string[]): Promise<{
        deleted: string[];
        missing: string[];
    }>;
    private buildBusinessRecipients;
    private resolveInputUsers;
    private parseEntities;
    setBusinessWorkHours(opts: {
        timezone?: string;
        openNow?: boolean;
        schedule?: Array<{
            day: string;
            openFrom: string;
            openTo: string;
        }>;
        clear?: boolean;
    }): Promise<void>;
    setBusinessLocation(opts: {
        address?: string;
        latitude?: number;
        longitude?: number;
        clear?: boolean;
    }): Promise<void>;
    setBusinessGreeting(opts: {
        shortcutId?: number;
        audience: "all_new" | "contacts_only" | "non_contacts" | "existing_only";
        includeUsers?: string[];
        excludeUsers?: string[];
        noActivityDays: number;
        clear?: boolean;
    }): Promise<void>;
    setBusinessAway(opts: {
        shortcutId?: number;
        schedule: "always" | "outside_hours" | "custom";
        customFrom?: number;
        customTo?: number;
        offlineOnly: boolean;
        audience: "all_new" | "contacts_only" | "non_contacts" | "existing_only";
        includeUsers?: string[];
        excludeUsers?: string[];
        clear?: boolean;
    }): Promise<void>;
    setBusinessIntro(opts: {
        title?: string;
        description?: string;
        stickerId?: string;
        stickerAccessHash?: string;
        stickerFileReference?: string;
        clear?: boolean;
    }): Promise<void>;
    createBusinessChatLink(opts: {
        message: string;
        title?: string;
        parseMode?: "md" | "html";
    }): Promise<BusinessChatLinksSummary["links"][0] & {
        slug: string;
    }>;
    editBusinessChatLink(opts: {
        slug: string;
        message: string;
        title?: string;
        parseMode?: "md" | "html";
    }): Promise<BusinessChatLinksSummary["links"][0]>;
    deleteBusinessChatLink(slug: string): Promise<void>;
    resolveBusinessChatLink(slug: string): Promise<ResolvedBusinessChatLinkSummary>;
    getGroupCall(chatId: string, options?: {
        limit?: number;
    }): Promise<GroupCallSummary>;
    getGroupCallParticipants(chatId: string, options?: {
        ids?: string[];
        sources?: number[];
        offset?: string;
        limit?: number;
    }): Promise<GroupCallParticipantsSummary>;
    getStarsStatus(chatId: string): Promise<StarsStatusSummary>;
    getStarsTransactions(chatId: string, options?: {
        inbound?: boolean;
        outbound?: boolean;
        ascending?: boolean;
        subscriptionId?: string;
        offset?: string;
        limit?: number;
    }): Promise<StarsStatusSummary>;
    getAvailableStarGifts(): Promise<Array<{
        id: string;
        stars: string;
        convertStars: string;
        limited: boolean;
        availabilityRemains?: number;
        availabilityTotal?: number;
        upgradeStars?: string;
    }>>;
    getSavedStarGifts(chatId: string, opts?: {
        limit?: number;
        offset?: string;
        excludeUnsaved?: boolean;
        excludeSaved?: boolean;
        excludeUnlimited?: boolean;
        excludeLimited?: boolean;
        excludeUnique?: boolean;
        sortByValue?: boolean;
    }): Promise<{
        count: number;
        nextOffset?: string;
        gifts: Array<{
            giftId: string;
            giftKind: "regular" | "unique";
            giftTitle?: string;
            stars?: string;
            convertStars?: string;
            msgId?: number;
            savedId?: string;
            fromPeerId?: string;
            date: number;
            unsaved: boolean;
            canUpgrade: boolean;
            upgradeStars?: string;
        }>;
    }>;
    saveStarGift(opts: {
        msgId?: number;
        chatId?: string;
        savedId?: string;
        unsave?: boolean;
    }): Promise<void>;
    convertStarGift(opts: {
        msgId?: number;
        chatId?: string;
        savedId?: string;
    }): Promise<void>;
    getStarsTopupOptions(): Promise<Array<{
        stars: string;
        currency: string;
        amount: string;
        extended: boolean;
    }>>;
    getStarsSubscriptions(chatId: string, opts?: {
        offset?: string;
        missingBalance?: boolean;
    }): Promise<{
        subscriptions: Array<{
            id: string;
            peerId: string;
            untilDate: number;
            periodSeconds: number;
            priceStars: string;
            canceled: boolean;
            title?: string;
        }>;
        nextOffset?: string;
    }>;
    changeStarsSubscription(chatId: string, subscriptionId: string, canceled: boolean): Promise<void>;
    getQuickReplies(hash?: string): Promise<QuickRepliesSummary>;
    getQuickReplyMessages(shortcutId: number, options?: {
        ids?: number[];
        hash?: string;
    }): Promise<QuickReplyMessagesSummary>;
    sendStory(chatId: string, filePath: string, opts: {
        type?: "photo" | "video";
        caption?: string;
        parseMode?: "md" | "html";
        privacy: StoryPrivacy;
        allowUserIds?: string[];
        disallowUserIds?: string[];
        period?: number;
        pinned?: boolean;
        noforwards?: boolean;
    }): Promise<{
        id: number | undefined;
        period: number;
    }>;
    editStory(chatId: string, storyId: number, opts: {
        filePath?: string;
        type?: "photo" | "video";
        caption?: string;
        parseMode?: "md" | "html";
        privacy?: StoryPrivacy;
        allowUserIds?: string[];
        disallowUserIds?: string[];
    }): Promise<{
        changed: string[];
    }>;
    deleteStories(chatId: string, ids: number[]): Promise<{
        deleted: number[];
    }>;
    sendStoryReaction(chatId: string, storyId: number, emoji: string, addToRecent?: boolean): Promise<void>;
    exportStoryLink(chatId: string, storyId: number): Promise<{
        link: string;
    }>;
    readStories(chatId: string, maxId: number): Promise<{
        ids: number[];
    }>;
    toggleStoryPinned(chatId: string, ids: number[], pinned: boolean): Promise<{
        affected: number[];
    }>;
    toggleStoryPinnedToTop(chatId: string, ids: number[]): Promise<{
        ok: boolean;
    }>;
    activateStealthMode(past?: boolean, future?: boolean): Promise<void>;
    getStoriesArchive(chatId: string, offsetId: number, limit: number): Promise<StoriesByIdSummary>;
    reportStory(chatId: string, ids: number[], option: string, message: string): Promise<ReportResultSummary>;
    getDiscussionMessage(chatId: string, messageId: number): Promise<DiscussionMessageSummary>;
    getGroupsForDiscussion(): Promise<GroupsForDiscussionSummary>;
    getMessageReadParticipants(chatId: string, messageId: number): Promise<ReadParticipantsSummary>;
    getOutboxReadDate(chatId: string, messageId: number): Promise<{
        readAt: string | null;
    }>;
    private resolveInputGroupCall;
}
