import { registerAccountTools } from "./account.js";
import { registerAuthTools } from "./auth.js";
import { registerBoostTools } from "./boosts.js";
import { registerBusinessTools } from "./business.js";
import { registerChatTools } from "./chats.js";
import { registerContactTools } from "./contacts.js";
import { registerExtraTools } from "./extras.js";
import { registerFactCheckTools } from "./fact-check.js";
import { registerFolderTools } from "./folders.js";
import { registerGroupCallTools } from "./group-calls.js";
import { registerMediaTools } from "./media.js";
import { registerMiniAppTools } from "./miniapps.js"; // Telegram MCP Starter (M2)
import { registerMiniAppUiTools } from "./miniapp-ui.js"; // Telegram MCP Starter (M4)
import { registerMessageTools } from "./messages.js";
import { registerMusicTools } from "./music.js";
import { registerQuickRepliesTools } from "./quick-replies.js";
import { registerReactionTools } from "./reactions.js";
import { registerSendMediaTools } from "./send-media.js";
import { registerStarsTools } from "./stars.js";
import { registerStickerTools } from "./stickers.js";
import { registerStoryTools } from "./stories.js";
import { registerTranscribeTools } from "./transcribe.js";
export function registerTools(server, telegram) {
    registerAuthTools(server, telegram);
    registerMessageTools(server, telegram);
    registerMiniAppTools(server, telegram); // Telegram MCP Starter (M2)
    registerMiniAppUiTools(server, telegram); // Telegram MCP Starter (M4)
    registerChatTools(server, telegram);
    registerMediaTools(server, telegram);
    registerSendMediaTools(server, telegram);
    registerContactTools(server, telegram);
    registerReactionTools(server, telegram);
    registerTranscribeTools(server, telegram);
    registerFactCheckTools(server, telegram);
    registerExtraTools(server, telegram);
    registerAccountTools(server, telegram);
    registerBusinessTools(server, telegram);
    registerFolderTools(server, telegram);
    registerStickerTools(server, telegram);
    registerStoryTools(server, telegram);
    registerBoostTools(server, telegram);
    registerGroupCallTools(server, telegram);
    registerStarsTools(server, telegram);
    registerQuickRepliesTools(server, telegram);
    registerMusicTools(server, telegram);
}
