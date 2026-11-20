// Tool calling over a prompt
//
// The web app's stream has no `tools` field, so a client's tools are bridged
// at the prompt. The wire format is a fenced JSON block — the shape GLM is
// trained on (its code-runner and analysis output is fenced JSON too), which
// it follows far more readily than XML-flavoured markup:
//
//   ```tool_calls
//   [{"name": "tool name", "arguments": {"argument": "value"}}]
//   ```
//
// The reply's blocks are parsed back into OpenAI `tool_calls` deltas. Tool
// results come back as `tool` role messages and are rendered as result fences
// on the next turn.

// FENCE is the info-string the call block opens with, and FENCE_RE its loose
// matcher: fences the model actually writes (```tool_calls, ```tool_calls
// json, ```tool-calls, bare ``` ahead of a calls array) all match.
const FENCE = "```tool_calls"
const FENCE_RE = /^```[ \t]*(tool[-_ ]?calls)?[ \t]*[a-z]*[ \t]*\r?\n/i

// isCallsArray tests whether a parsed JSON value is shaped like a call list:
// an array of objects that each carry a name (the arguments may be missing).
function isCallsArray(value) {
  if (!Array.isArray(value) || !value.length) return false
  return value.every(
    (call) => call && typeof call === "object" && typeof call.name === "string" && call.name.trim() !== "",
  )
}

// coerceArguments folds one call's arguments into a JSON string: objects as
// they are, strings parsed when they are JSON themselves (models often hand
// arguments over pre-stringified), anything else an object around it.
function coerceArguments(args) {
  if (args == null) return "{}"
  if (typeof args === "object") return JSON.stringify(args)
  const text = String(args).trim()
  if (!text) return "{}"
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed ?? {})
    } catch {
      return JSON.stringify({ raw: text })
    }
  }
  return JSON.stringify({ raw: text })
}

// toolsToPrompt is the protocol block a turn with tools opens its prompt
// with: the call shape, the house rules, and the tools.
function toolsToPrompt(tools) {
  const list = (tools ?? [])
    .filter((tool) => typeof tool?.function?.name === "string")
    .map((tool) =>
      JSON.stringify({
        name: tool.function.name,
        description: typeof tool.function.description === "string" ? tool.function.description : "",
        parameters: tool.function.parameters ?? {},
      }),
    )
  if (!list.length) return ""
  return [
    "# Tool calling protocol (MANDATORY)",
    "",
    "You have function tools available. They are listed at the end of this block.",
    "",
    "## How to call a tool",
    "",
    "End your reply with EXACTLY this fenced JSON block:",
    "",
    "```tool_calls",
    '[{"name": "tool_name", "arguments": {"param": "value"}}]',
    "```",
    "",
    "## Rules",
    "",
    "1. **Call a tool instead of answering in prose whenever a tool can do the job.** Reading a file, running a command, searching code, editing, fetching a URL — if a listed tool covers it, CALL IT. A plain-text answer to an action request is a failure.",
    '2. Multiple calls in one turn go in the same array: `[{"name": …, "arguments": …}, {"name": …, "arguments": …}]`.',
    "3. `arguments` is a JSON object using the tool's parameter names exactly.",
    "4. The block must be a fenced code block with `tool_calls` as its info string, and nothing else in the fence.",
    "5. Write no text after the closing fence: tool results arrive with the next turn.",
    "6. When no tool fits the request, or the user only wants an explanation, answer normally and write no block at all.",
    "",
    "## The tools",
    "",
    ...list,
  ].join("\n")
}

// renderToolCall draws one call as the model's own fenced JSON, for a history
// that shows the model what it called and how. The arguments the client
// echoes back are usually the JSON string the call was made with; when that
// string does not parse (the client un-escapes backslashes along the way,
// JSON.parse rejects `\U`), the raw string is kept verbatim inside a string
// argument rather than wrapped in a fake `{raw}` object the model would read
// as a different call than the one it made.
function renderToolCall(name, args) {
  if (typeof args === "string") {
    try {
      return `${FENCE}\n${JSON.stringify([{ name: String(name), arguments: JSON.parse(args) }], null, 2)}\n\`\`\``
    } catch {
      return `${FENCE}\n${JSON.stringify([{ name: String(name), arguments: args }], null, 2)}\n\`\`\``
    }
  }
  return `${FENCE}\n${JSON.stringify([{ name: String(name), arguments: args ?? {} }], null, 2)}\n\`\`\``
}

// renderToolResult draws one tool result the same way, so the model reads its
// own tools' output in the shape it wrote the calls in.
function renderToolResult(name, content) {
  return `Tool result (${name}): ${String(content)}`
}

// parseArguments reads the arguments of a call the client sent back.
function parseArguments(args) {
  if (typeof args === "string") return args
  return JSON.stringify(args ?? {})
}

// safeName keeps a parameter name inside what the wire can carry (kept for
// compatibility with tests importing it).
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_.:-]/g, "_") || "value"
}

// cdata is retired with the DSML wire format; kept as identity for callers.
function cdata(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? null)
}

export { toolsToPrompt, renderToolCall, renderToolResult, parseArguments, cdata, safeName, FENCE, FENCE_RE, isCallsArray, coerceArguments }
