// Tool calling over a prompt
//
// The web app's stream has no `tools` field, so a client's tools are bridged
// at the prompt: the turn's prompt opens with the protocol below, teaching
// the model to call tools in the DSML shape it knows from the page's own
// agent mode:
//
//   <|DSML|tool_calls>
//     <|DSML|invoke name="tool name">
//       <|DSML|parameter name="argument"><![CDATA[value]]></|DSML|parameter>
//     </|DSML|invoke>
//   </|DSML|tool_calls>
//
// and the reply's blocks are parsed back into OpenAI `tool_calls` deltas. Tool
// results come back as `tool` role messages and are rendered as result blocks
// on the next turn.

// cdata folds a value into a DSML parameter body: strings wrapped in CDATA
// (splitting any `]]>` inside), other values as their JSON.
function cdata(value) {
  if (typeof value === "string") return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
  return JSON.stringify(value ?? null)
}

// safeName keeps a parameter name inside what the markup can carry.
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_.:-]/g, "_") || "value"
}

// toolsToPrompt is the protocol block a turn with tools opens its prompt
// with: one block per tool, the call shape, and the house rules.
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
    "[Tool calling]",
    "You can call the tools listed at the end of this block. To call one, end your reply with a block of exactly this shape:",
    "<|DSML|tool_calls>",
    '  <|DSML|invoke name="tool name">',
    '    <|DSML|parameter name="argument"><![CDATA[value]]></|DSML|parameter>',
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
    '- Each argument is its own <|DSML|parameter> with the exact parameter name from the tool\'s schema.',
    "- String values go in CDATA as shown; numbers, booleans and JSON objects are written as they are.",
    "You may put several <|DSML|invoke> inside one <|DSML|tool_calls> block to call tools in parallel.",
    "Do not wrap a call in code fences, and write nothing after the calls: their results arrive with the next turn.",
    "Use exactly this markup — never any other tag style.",
    "When no tool fits, answer normally and call nothing.",
    "The tools:",
    ...list,
  ].join("\n")
}

// renderToolCall draws one call as the model's own markup, for a history that
// shows the model what it called and how.
function renderToolCall(name, args) {
  let value
  try {
    value = JSON.parse(typeof args === "string" ? args : "{}")
  } catch {
    value = { raw: String(args) }
  }
  const parameters = Object.entries(value ?? {})
    .map(([key, v]) => `  <|DSML|parameter name="${safeName(key)}">${cdata(v)}</|DSML|parameter>`)
    .join("\n")
  return [
    "<|DSML|tool_calls>",
    `  <|DSML|invoke name="${String(name).replace(/"/g, "&quot;")}">`,
    parameters || "  (no arguments)",
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
  ].join("\n")
}

// renderToolResult draws one tool result the same way, so the model reads its
// own tools' output in the shape it wrote the calls in.
function renderToolResult(name, content) {
  return `<|DSML|tool_result name="${String(name).replace(/"/g, "&quot;")}"><![CDATA[${String(content).replaceAll("]]>", "]]]]><![CDATA[>")}]]></|DSML|tool_result>`
}

// parseToolCall reads the arguments of a call the client sent back.
function parseArguments(args) {
  if (typeof args === "string") return args
  return JSON.stringify(args ?? {})
}

export { toolsToPrompt, renderToolCall, renderToolResult, parseArguments, cdata, safeName }
