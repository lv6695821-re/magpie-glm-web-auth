// Identity, models and the page constants this plugin is built on.

const PROVIDER = "glm-web"
const NAME = "GLM 智谱清言 (chatglm.cn)"
const DEFAULT_ORIGIN = "https://chatglm.cn"
const NPM = "@ai-sdk/openai-compatible"

// The page's own headers, as the web client sends them.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

// The chatglm.cn endpoints the page's own client calls:
//   POST /chatglm/user-api/user/refresh        refresh_token → access_token
//   POST /chatglm/backend-api/assistant/stream the turn, answered as SSE
//   POST /chatglm/backend-api/assistant/conversation/delete
//                                               remove a conversation
const BASE_PATH = "/chatglm"
const REFRESH_PATH = `${BASE_PATH}/user-api/user/refresh`
const STREAM_PATH = `${BASE_PATH}/backend-api/assistant/stream`
const DELETE_PATH = `${BASE_PATH}/backend-api/assistant/conversation/delete`

// The default assistant every plain chat runs on. The page's model switch
// (GLM-5.x / 4.x / thinking) is meta_data.chat_mode + if_plus_model, not
// another assistant id.
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796"

// The model name the upstream reports in its stream parts, kept only for
// label parity; the wire never carries the exposed ids.
const MODELS = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    thinking: "on", // chat_mode "zero": the page's thinking switch
    search: "page", // follows the page's own toggle (on by default)
    context: 128_000,
    output: 32_768,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    thinking: "on",
    search: "page",
    context: 128_000,
    output: 32_768,
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash",
    thinking: "off",
    search: "page",
    context: 128_000,
    output: 8_192,
  },
  {
    id: "glm-5.3-search",
    name: "GLM-5.3 (search)",
    thinking: "on",
    search: "on", // forced on, the -search variant
    context: 128_000,
    output: 32_768,
  },
  {
    id: "glm-4.7-flash-search",
    name: "GLM-4.7 Flash (search)",
    thinking: "off",
    search: "on",
    context: 128_000,
    output: 8_192,
  },
]

const CHAT_PATHS = {
  "/chat/completions": "chat",
}

function modelOf(model) {
  return {
    name: model.name,
    reasoning: model.thinking === "on",
    // Tools ride the prompt as a protocol, not the wire: the stream has no
    // tools field, so the plugin teaches the model the DSML call shape and
    // parses the reply's blocks back into OpenAI tool_calls.
    tool_call: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: model.context, output: model.output },
    cost: { input: 0, output: 0 },
  }
}

function configModels() {
  return Object.fromEntries(MODELS.map((model) => [model.id, modelOf(model)]))
}

function accountLabel(token) {
  return `chatglm.cn · ${token.slice(0, 8)}…`
}

export {
  PROVIDER,
  NAME,
  DEFAULT_ORIGIN,
  NPM,
  USER_AGENT,
  BASE_PATH,
  REFRESH_PATH,
  STREAM_PATH,
  DELETE_PATH,
  DEFAULT_ASSISTANT_ID,
  MODELS,
  CHAT_PATHS,
  modelOf,
  configModels,
  accountLabel,
}
