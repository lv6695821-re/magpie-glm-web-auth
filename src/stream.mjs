// The reply stream
//
// The completion answers with SSE `data:` frames, each one a JSON snapshot:
//   {conversation_id, status, parts: [{logic_id, role, status, content: […]}]}
// A part is one logical paragraph of the answer; its content holds typed
// items — {"type":"text","text":…} for the reply, {"type":"think","think":…}
// for the reasoning, code and execution_output for the page's code runner,
// tool_result for its search. While a part streams, each frame carries only
// the fragment that grew it; the frame that finishes the part carries the
// whole text back. The reader keeps each part by logic_id and re-renders,
// reconciling against what it already sent (a shared prefix emits the tail, a
// diverged frame is a fragment taken whole); a part's status "finish" fixes
// its text, and the top-level status "finish" ends the turn ("intervene" is
// the page's content-filtered end).
//
// The model writes tool calls as DSML markup in the text channel (the page's
// built-in agent format); with tools on the turn those blocks parse into
// toolCalls, and without them they fold into the reasoning so the reply never
// shows raw markup. A marker a delta cut in half is held back until the rest
// arrives.

// The DSML tags, as the page's own client renders them: open with <|DSML|,
// close with </|DSML>. The model writes several malformed variants (missing
// pipes, trailing pipes, toolcalls run together, fullwidth ｜｜ bars); the
// scanner tolerates them by matching the tag head loosely and re-folding what
// it reads.
const DSML_HEAD = "<|dsml"
const DSML_TAIL = "</|dsml"
// The tolerance variants, longest first so a specific one matches before a
// loose one swallows more. The fullwidth-bar form <｜｜DSML｜｜ (the other
// vendor's client renders DSML this way) normalizes to <|dsml by the fold.
const DSML_HEADS = ["<|dsml|", "<|dsml", "<||dsml|", "<|dsmltool_"]
const DSML_TAILS = ["</|dsml|", "</|dsml", "<|/dsml", "</||dsml|"]

// The XML shapes the model also writes: plain <tool_calls>, <ml_tool_calls>.
const XML_HEAD = "<tool_calls"
const XML_TAIL = "</tool_calls"

// The fenced-JSON call block, the prompt protocol's own wire shape:
//   ```tool_calls
//   [{"name": …, "arguments": {…}}]
//   ```
// The head matches loosely (info-string variants, a bare fence ahead of a
// calls array); the close is the block's closing fence.
const FENCE_HEAD = "```"
const FENCE_INFO = /^```[ \t]*(tool[-_ ]?calls)?[ \t]*[a-z]*[ \t]*\r?\n/i
const FENCE_CLOSE = /\n```/

// A block that swallows more than this without closing is treated as broken:
// the rest of the reply flows as text again rather than into the hold.
const RUNAWAY = 65_536

// tailHold is the length of the longest tail of s that could still grow into
// one of the markers, 0 when none could. The markers are lowercase patterns,
// so the tail compares in lowercase.
function tailHold(s, markers) {
  const lowered = s.toLowerCase()
  const longest = Math.max(...markers.map((marker) => marker.length)) - 1
  for (let n = Math.min(s.length, longest); n > 0; n--) {
    const tail = lowered.slice(-n)
    if (markers.some((marker) => marker.startsWith(tail))) return n
  }
  return 0
}

// TextDiff holds one channel's (text or reasoning) running total and computes
// the next increment. The wire carries two shapes for one part: streaming
// frames bring the new fragment only ("天", "之所以", …), and the frame that
// finishes the part brings the whole text back again. Either way the next
// state shares a prefix with what was sent: growth past it emits the tail,
// a re-rendered shrink waits, and a diverged frame is a fragment continuing
// the part — taken whole.
class PartTracker {
  constructor() {
    this.parts = [] // logic_id, in arrival order
    this.sent = new Map() // logic_id → text already emitted for that part
  }

  // deltas returns the newly visible text of the parts, in order. Parts never
  // interleave on the wire — one part finishes before the next opens — so a
  // plain join is the faithful stream.
  deltas(rendered) {
    const out = []
    for (const part of rendered) {
      const { logicId, text } = part
      if (!text) continue
      if (!this.parts.includes(logicId)) {
        this.parts.push(logicId)
        this.sent.set(logicId, text)
        out.push(text)
        continue
      }
      const before = this.sent.get(logicId) ?? ""
      if (text === before) continue
      if (text.startsWith(before)) {
        // the frame carried the part whole: emit what grew past the sent text
        this.sent.set(logicId, text)
        out.push(text.slice(before.length))
      } else if (before.startsWith(text)) {
        // the part shrank — the page re-rendered it shorter: the next frame
        // re-syncs from the common prefix, nothing to send for now
        this.sent.set(logicId, text)
      } else {
        // diverged: the frame is a fragment continuing the part, taken whole
        this.sent.set(logicId, before + text)
        out.push(text)
      }
    }
    return out.join("")
  }
}

class PartReader {
  constructor({ tools = false } = {}) {
    this.conversationId = null
    this.status = null
    this.finished = false
    this.toolCalls = []
    // The parts by logic_id, in arrival order; re-rendered on every snapshot.
    this.order = []
    this.parts = new Map()
    this.textTracker = new PartTracker()
    this.reasoningTracker = new PartTracker()
    this.text = ""
    this.reasoning = ""
    // Two kinds of markup ride the text channel: with tools on the turn a
    // DSML block is a tool call; without, it is the model's own business and
    // stays in the reasoning. A marker a delta cut in half is held.
    this.tools = tools
    this.block = null // null | "tool"
    this.toolBuf = ""
    this.hold = ""
    this.seen = 0
  }

  get markers() {
    return this.tools
      ? [...DSML_HEADS, ...DSML_TAILS, XML_HEAD, XML_TAIL, FENCE_HEAD]
      : [...DSML_HEADS, ...DSML_TAILS]
  }

  // apply folds one snapshot frame into the reply's state.
  apply(frame) {
    if (!frame || typeof frame !== "object") return
    if (typeof frame.conversation_id === "string") this.conversationId = frame.conversation_id
    if (typeof frame.status === "string") this.status = frame.status
    const parts = frame.parts
    if (!Array.isArray(parts)) return
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const logicId = typeof part.logic_id === "string" ? part.logic_id : String(part.logic_id ?? "")
      if (!logicId) continue
      if (!this.parts.has(logicId)) this.order.push(logicId)
      this.parts.set(logicId, part)
    }
    const rendered = this.render()
    const textDelta = this.textTracker.deltas(rendered.textParts)
    const reasoningDelta = this.reasoningTracker.deltas(rendered.reasoningParts)
    if (reasoningDelta) this.reasoning += reasoningDelta
    if (textDelta) this.emitText(textDelta)
  }

  // render walks the parts in arrival order and splits each one's content
  // into the reply's text and the reasoning.
  render() {
    const textParts = []
    const reasoningParts = []
    for (const logicId of this.order) {
      const part = this.parts.get(logicId)
      const content = part?.content
      if (!Array.isArray(content)) continue
      let text = ""
      let reasoning = ""
      for (const item of content) {
        if (!item || typeof item !== "object") continue
        const type = String(item.type ?? "")
        if (type === "text" && typeof item.text === "string") text += item.text
        else if (type === "think" && typeof item.think === "string") reasoning += item.think
        // the page's code runner and its search results are the model's own
        // process, shown as it happens: the reasoning keeps them visible
        else if (type === "code" && typeof item.code === "string") reasoning += `\n\`\`\`python\n${item.code}\n\`\`\`\n`
        else if (type === "execution_output" && typeof item.content === "string") reasoning += `\n${item.content}\n`
        else if (type === "tool_result") this.searchNotes(item, reasoningParts)
        else if (type === "quote_result" && Array.isArray(item.metadata_list)) {
          for (const quote of item.metadata_list) {
            if (quote && typeof quote === "object" && typeof quote.title === "string") reasoning += `> 检索 ${quote.title}(${quote.url ?? ""})\n`
          }
        }
        // images arrive as their own content item when they are finished
        else if (type === "image" && Array.isArray(item.image) && String(part.status ?? "") === "finish") {
          for (const image of item.image) {
            if (image && typeof image === "object" && /^https?:\/\//.test(String(image.image_url ?? ""))) {
              text += `\n![image](${image.image_url})\n`
            }
          }
        }
      }
      if (text) textParts.push({ logicId, text })
      if (reasoning) reasoningParts.push({ logicId, text: reasoning })
    }
    return { textParts, reasoningParts }
  }

  // searchNotes folds a tool_result's search references into the reasoning.
  searchNotes(item, reasoningParts) {
    const extra = item?.meta_data?.tool_result_extra?.search_results
    if (!Array.isArray(extra)) return
    let notes = ""
    for (const result of extra) {
      if (result && typeof result === "object" && typeof result.title === "string") {
        notes += `> 检索 ${result.title}(${result.url ?? ""})\n`
      }
    }
    if (notes) reasoningParts.push({ logicId: `search-${reasoningParts.length}`, text: notes })
  }

  // emitText folds one piece of reply text, keeping markup out of the reply:
  // with tools on the turn a DSML block is parsed into toolCalls; without, it
  // is the model's own business, kept in the reasoning. A marker a delta cut
  // in half is held back until the rest of it arrives.
  emitText(content) {
    let buffer = this.hold + content
    this.hold = ""
    for (;;) {
      if (this.block === "json") {
        // the whole fenced block is held until its closing fence arrives
        this.toolBuf += buffer
        buffer = ""
        const close = FENCE_CLOSE.exec(this.toolBuf)
        if (!close) {
          if (this.toolBuf.length > RUNAWAY) {
            this.reasoning += this.toolBuf
            this.toolBuf = ""
            this.block = null
          }
          return
        }
        const inner = this.toolBuf.slice(0, close.index)
        const after = this.toolBuf.slice(close.index + close[0].length)
        this.toolBuf = ""
        this.block = null
        const calls = parseJsonCalls(inner)
        if (calls.length) for (const call of calls) this.toolCalls.push(call)
        else this.reasoning += inner
        buffer = after
        continue
      }
      if (this.block === "tool") {
        // the whole block is held until its closing tag: accumulate first,
        // then search — a tag split across deltas spans buffer and toolBuf.
        // The close that ends the block is the ROOT's own (</…tool_calls>
        // or </…calls>): the inner tags' closes (</…parameter>, </…invoke>)
        // stay inside the block, so they are skipped while scanning.
        this.toolBuf += buffer
        buffer = ""
        const tail = this.rootTail(this.toolBuf)
        if (tail === -1) {
          if (this.toolBuf.length > RUNAWAY) {
            // a block that never closes: it was meant as markup, not reply —
            // give it to the reasoning and let the rest flow as text
            this.reasoning += this.toolBuf
            this.toolBuf = ""
            this.block = null
          }
          return
        }
        const inner = this.toolBuf.slice(0, tail)
        const after = this.toolBuf.slice(tail + this.rootTailText(this.toolBuf, tail).length)
        this.toolBuf = ""
        this.block = null
        const calls = parseToolBlock(inner)
        if (calls.length) for (const call of calls) this.toolCalls.push(call)
        // a block that does not parse was the model reaching for a tool it
        // cannot have; it is shown in the reasoning, never in the reply
        else this.reasoning += inner
        buffer = after
        continue
      }
      // plain text: find the earliest opening marker
      const at = this.headTag(buffer)
      if (at === -1) {
        const keep = tailHold(buffer, this.markers)
        if (keep) this.hold = buffer.slice(buffer.length - keep)
        const text = keep ? buffer.slice(0, buffer.length - keep) : buffer
        if (text) this.text += text
        this.seen += text.length
        return
      }
      if (at > 0) {
        this.text += buffer.slice(0, at)
        this.seen += at
      }
      buffer = buffer.slice(at)
      // A fence head can't be classified on arrival: whether it opens a call
      // block or is the reply's own code fence is decided by the info string
      // that follows (```tool_calls vs ```python), and deltas cut inside it.
      // The head stays held until a newline or a non-info character arrives;
      // a fence that ends the stream unclassified is ordinary text.
      if (buffer.toLowerCase().startsWith(FENCE_HEAD)) {
        const info = buffer.match(FENCE_INFO)
        if (info) {
          // classified: a call block only when the info string names it
          if (info[1]) {
            this.block = "json"
            buffer = buffer.slice(info[0].length)
            this.toolBuf = ""
            continue
          }
          // an ordinary code fence: the head flows as text
          this.text += buffer.slice(0, FENCE_HEAD.length)
          this.seen += FENCE_HEAD.length
          buffer = buffer.slice(FENCE_HEAD.length)
          continue
        }
        const after = buffer.slice(FENCE_HEAD.length)
        // a backtick, spaces, or an info word may still grow into either
        // shape: hold the head until the newline (or a character that ends
        // the info string, which FENCE_INFO will then match or not). An empty
        // after is held too — deltas deliver the head one backtick at a time,
        // and the classification needs what follows. A fence still held when
        // the stream ends is ordinary text: flushHold puts it back.
        this.hold = buffer
        return
        // a newline came and FENCE_INFO didn't match: ordinary fence
        this.text += buffer.slice(0, FENCE_HEAD.length)
        this.seen += FENCE_HEAD.length
        buffer = buffer.slice(FENCE_HEAD.length)
        continue
      }
      this.block = "tool"
      // the opening marker is a fixed prefix of the block: consume it, then
      // the block runs to its closing tag — the tool loop above takes it
      // from here once the whole remainder has arrived
      const headLength = this.headTagText(buffer).length
      this.toolBuf = buffer.slice(0, headLength)
      buffer = buffer.slice(headLength)
      this.toolBuf += buffer
      buffer = ""
    }
  }

  // headTag finds the first opening marker in the buffer, -1 when none.
  headTag(buffer) {
    let best = -1
    for (const marker of this.markers) {
      const at = buffer.toLowerCase().indexOf(marker)
      if (at !== -1 && (best === -1 || at < best)) best = at
    }
    return best
  }

  // headTagText is the actual text at the buffer's head that matches one of
  // the opening markers (case preserved).
  headTagText(buffer) {
    const lowered = buffer.toLowerCase()
    for (const marker of this.markers) {
      if (lowered.startsWith(marker)) return buffer.slice(0, marker.length)
    }
    // a marker matched somewhere inside: take the longest that fits the head
    return buffer.slice(0, this.headTag(buffer) === 0 ? 1 : 0) || ""
  }

  // rootTail finds the close that ends the block: the root tag's own. The
  // root opens as <|DSML|tool_calls> (or a malformed variant, or plain
  // <tool_calls>), so its close is the first tail whose tag names tool_calls
  // — an inner </|DSML|parameter> does not end it.
  rootTail(block) {
    const lowered = block.toLowerCase()
    const rootCloses = [
      /<\/(?:\|?dsml\|?)?tool_?calls\s*\|?\s*>/, // </|DSML|tool_calls>, </dsmltool_calls>
      /<\/tool_?calls\s*>/, // </tool_calls>
      /<(?:\|\/dsml\|?)tool_?calls\s*\|?\s*>/, // <|/dsml|tool_calls> (the compact form)
    ]
    let best = -1
    for (const pattern of rootCloses) {
      const match = pattern.exec(lowered)
      if (match && (best === -1 || match.index < best)) best = match.index
    }
    return best
  }

  // rootTailText is the root close's actual text at that position.
  rootTailText(block, at) {
    const lowered = block.toLowerCase()
    const rootCloses = [
      /<\/(?:\|?dsml\|?)?tool_?calls\s*\|?\s*>/,
      /<\/tool_?calls\s*>/,
      /<(?:\|\/dsml\|?)tool_?calls\s*\|?\s*>/,
    ]
    for (const pattern of rootCloses) {
      const match = pattern.exec(lowered.slice(at))
      if (match && match.index === 0) return block.slice(at, at + match[0].length)
    }
    return ""
  }

  // tailTag finds the first closing marker in the held block, -1 when none.
  tailTag(block) {
    let best = -1
    const lowered = block.toLowerCase()
    for (const marker of [...DSML_TAILS, XML_TAIL]) {
      const at = lowered.indexOf(marker)
      if (at !== -1 && (best === -1 || at < best)) best = at
    }
    return best
  }

  // tailTagText is the closing marker's actual text at that position.
  tailTagText(block, at) {
    const lowered = block.toLowerCase()
    for (const marker of [...DSML_TAILS, XML_TAIL]) {
      if (lowered.startsWith(marker, at)) return block.slice(at, at + marker.length)
    }
    return ""
  }

  // flushHold puts out what a finished stream left held: a tail that never
  // grew into a marker is text again, and a half-open call block —
  // unexecutable by definition — goes to the reasoning with the rest of its
  // block.
  flushHold() {
    if (this.block === "json" && this.toolBuf) {
      this.reasoning += this.toolBuf
      this.toolBuf = ""
      this.block = null
    }
    if (this.block === "tool" && this.toolBuf) {
      this.reasoning += this.toolBuf
      this.toolBuf = ""
      this.block = null
    }
    if (!this.hold) return
    const held = this.hold
    this.hold = ""
    // A held fence head is ordinary text, never reasoning: a call block's
    // head always grows its info string before the stream can end with a
    // call pending, so one that reaches here unclassified is the reply's
    // own code fence (or its stray close).
    if (held.toLowerCase().startsWith(FENCE_HEAD)) {
      this.text += held
      return
    }
    // a held tail that is a partial marker, not text: the reasoning keeps it
    if (this.markers.some((marker) => marker.startsWith(held.toLowerCase()))) this.reasoning += held
    else this.text += held
  }
}

// ---------------------------------------------------------------------------
// DSML parsing: one complete block's inner text into tool calls.
// ---------------------------------------------------------------------------

// parameterValue reads one parameter's value: CDATA unescaped, JSON when it
// parses, scalars coerced.
function parameterValue(text) {
  const value = text.trim()
  if (!value) return ""
  if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) return value.slice(9, -3)
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

// parseToolBlock reads one block's inner text into calls. The block holds
// invoke elements, each with a name and parameter children:
//   <|DSML|tool_calls>
//     <|DSML|invoke name="tool">
//       <|DSML|parameter name="arg"><![CDATA[value]]></|DSML|parameter>
//     </|DSML|invoke>
//   </|DSML|tool_calls>
// Malformed variants (missing pipes, toolcalls run together, plain XML) are
// tolerated by matching the element names loosely.
function parseToolBlock(inner) {
  const calls = []
  const invokePattern = /<[^>]*?invoke\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/[^>]*?invoke[^>]*>/gi
  for (const invoke of inner.matchAll(invokePattern)) {
    const name = invoke[1]?.trim()
    if (!name) continue
    const args = {}
    const parameterPattern = /<[^>]*?parameter\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/[^>]*?parameter[^>]*>/gi
    for (const parameter of invoke[2].matchAll(parameterPattern)) {
      const key = parameter[1]?.trim()
      if (key) args[key] = parameterValue(parameter[2])
    }
    // an invoke with no parameters named is not a call the client can run
    if (!Object.keys(args).length && !invoke[2].trim()) {
      calls.push({ id: `call_${Math.random().toString(36).slice(2, 12)}`, name, arguments: "{}" })
      continue
    }
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 12)}`,
      name,
      arguments: JSON.stringify(args),
    })
  }
  return calls
}

// parseJsonCalls reads one fenced JSON block's text into tool calls. The
// prompt protocol's wire shape is a JSON array of {name, arguments} — but
// models drift: a single object instead of an array, an "arguments" that is
// itself a JSON string, a "parameters"/"args" alias for arguments, stray
// prose around the JSON. Each is tolerated here; anything else yields no
// calls (the block folds into the reasoning instead of the reply).
function parseJsonCalls(inner) {
  const calls = []
  // carve the outermost JSON value out of the block: the first bracket-ish
  // character through its matching close, ignoring fences and prose
  const start = inner.search(/[[{]/)
  if (start === -1) return calls
  const open = inner[start]
  const close = open === "[" ? "]" : "}"
  let depth = 0
  let inString = false
  let escape = false
  let end = -1
  for (let i = start; i < inner.length; i++) {
    const ch = inner[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) return calls
  let value
  try {
    value = JSON.parse(inner.slice(start, end))
  } catch {
    return calls
  }
  const list = Array.isArray(value) ? value : [value]
  for (const call of list) {
    if (!call || typeof call !== "object") continue
    const name = typeof call.name === "string" ? call.name.trim() : typeof call.tool === "string" ? call.tool.trim() : ""
    if (!name) continue
    let args = call.arguments ?? call.args ?? call.parameters ?? {}
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        args = { raw: args }
      }
    }
    if (args == null || typeof args !== "object") args = { raw: String(args) }
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 12)}`,
      name,
      arguments: JSON.stringify(args),
    })
  }
  return calls
}

// iterSse reads `data:` JSON frames off a fetch body.
async function* iterSse(body) {
  const decoder = new TextDecoder()
  let buffer = ""
  const pending = []
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line) {
        if (pending.length) {
          const data = pending.join("\n")
          pending.length = 0
          if (data.trim() !== "[DONE]") {
            try {
              yield JSON.parse(data)
            } catch {
              // a frame that isn't JSON is the page's business, not ours
            }
          }
        }
        continue
      }
      if (line.startsWith(":")) continue
      const colon = line.indexOf(":")
      if (colon === -1) continue
      const field = line.slice(0, colon)
      let value = line.slice(colon + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "data") pending.push(value)
    }
  }
  if (pending.length) {
    try {
      yield JSON.parse(pending.join("\n"))
    } catch {
      // ignore a trailing partial frame
    }
  }
}

export { PartReader, PartTracker, iterSse, parseToolBlock, parseJsonCalls, tailHold }
