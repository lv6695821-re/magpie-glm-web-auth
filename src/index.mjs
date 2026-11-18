// GLM 智谱清言 (chatglm.cn) as an OpenCode/magpie provider plugin.
//
// The account is the one the user is already signed in to in their browser:
// chatglm.cn keeps its chatglm_refresh_token in Local Storage (and a cookie),
// so the sign-in reads that token out of a signed-in browser profile (or
// takes it pasted) and exchanges it for the short-lived access_token the
// page's own requests carry. Requests go to the web app's own API, which the
// browser and this plugin both use:
//
//   POST /chatglm/user-api/user/refresh        refresh_token → access_token
//   POST /chatglm/backend-api/assistant/stream the turn, answered as SSE
//   POST /chatglm/backend-api/assistant/conversation/delete
//                                              remove a conversation
//
// Everything is the web app's contract, not Zhipu's OpenAI-compatible
// platform API (open.bigmodel.cn, which takes a pay-as-you-go key): the
// account is a chatglm.cn session, so it is used the way the chat page uses
// it, with the same headers and the same signature (x-timestamp/x-nonce/
// x-sign, the MD5 the page computes over its checksummed timestamp, a nonce
// and the secret baked into its public bundle).
//
// The reply arrives as SSE snapshots: each frame is the conversation's whole
// parts list, and the reader keeps the parts by logic_id, re-renders and
// emits only what is new. A part's "think" content is the reasoning and its
// "text" the reply; the page's model switch (GLM-5.x thinking, flash) is
// meta_data.chat_mode, not another endpoint. Models are exposed with the
// platform's own names (glm-5.3, glm-4.7-flash, …) plus a -search variant
// that pins the page's web-search toggle on.
//
// A turn chatglm.cn turns away (conversation deleted, busy) starts a fresh
// conversation carrying the whole labelled history once, so the reply keeps
// its context.

import { PROVIDER, MODELS } from "./config.mjs"
import { server } from "./plugin.mjs"
import {
  findBrowserToken,
  findLiveBrowserToken,
  browserTokens,
  whoAmI,
  tokenFromLevelDb,
  tokenCandidatesFromLevelDb,
  chromiumRoots,
} from "./browser-token.mjs"
import { signed, json, deleteConversation, isTitleRequest } from "./api.mjs"
import { TokenKeeper } from "./token.mjs"
import { PartReader, PartTracker, iterSse, parseToolBlock } from "./stream.mjs"
import { messagesToPrompt, messageSignature, finishReason } from "./openai.mjs"
import { toolsToPrompt, renderToolCall, renderToolResult } from "./toolcall.mjs"
import { runTurn } from "./turn.mjs"

export { server }

export default { id: PROVIDER, server }

// for tests
export const _internal = {
  MODELS,
  PartReader,
  PartTracker,
  iterSse,
  parseToolBlock,
  messagesToPrompt,
  messageSignature,
  toolsToPrompt,
  renderToolCall,
  renderToolResult,
  findBrowserToken,
  findLiveBrowserToken,
  browserTokens,
  whoAmI,
  tokenFromLevelDb,
  tokenCandidatesFromLevelDb,
  chromiumRoots,
  signed,
  json,
  deleteConversation,
  isTitleRequest,
  TokenKeeper,
  runTurn,
  finishReason,
}
