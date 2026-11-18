// A fake chatglm.cn: the endpoints and the SSE snapshot stream the plugin
// talks to, so its fetch is exercised without an account.
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"

// The challenge the fake's signature check accepts: the MD5 the page computes
// over its checksummed timestamp, the nonce and the secret.
const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"

// signedNow builds the page's timestamp with its checksum digit folded in.
function signedNow() {
  const now = String(Date.now())
  const digits = [...now].map(Number)
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10
  return now.slice(0, -2) + checksum + now.slice(-1)
}

const json = (res, value, status = 200) => {
  const body = JSON.stringify(value)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

const ok = (result) => ({ code: 0, message: "", result })

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

// start brings up the fake and returns what to point the plugin's host at.
//
// replies is a list of functions (payload, conversation) → {text, think,
// status, parts…} — a script the fake plays through, or the default single
// reply. Options:
//   reply      the plain reply text
//   think      the reasoning text (a "think" part)
//   status     the turn's final status ("finish", "intervene")
//   searchNotes  text folded in as a tool_result's search references
//   refreshFail refuse the token refresh (the sign-in is dead)
//   busyOnce   answer the busy business code once before the stream
//   noStream   answer JSON instead of an event stream
export async function start({ reply = "Hello", think = "", status = "finish", searchNotes = "", refreshFail = false, busyOnce = false, noStream = false, refuseConversation = false } = {}) {
  const seen = { refreshes: [], completions: [], deletions: [], headers: [] }
  let conversationCounter = 0
  let busySpent = false
  const conversations = new Map() // id → {parts: []}
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    seen.headers.push({ path: url.pathname, headers: req.headers })
    if (url.pathname === "/chatglm/user-api/user/refresh") {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "")
      seen.refreshes.push({ token })
      if (refreshFail || !token || token === "bad-token") {
        return json(res, { code: 40102, message: "Authorization Failed (token expired)", result: null })
      }
      return json(res, ok({ access_token: `access-${token.slice(0, 8)}`, refresh_token: token }))
    }
    if (url.pathname === "/chatglm/backend-api/assistant/conversation/delete") {
      const { assistant_id, conversation_id } = await body(req)
      seen.deletions.push(conversation_id)
      conversations.delete(conversation_id)
      return json(res, ok(null))
    }
    if (url.pathname === "/chatglm/backend-api/assistant/stream") {
      const payload = await body(req)
      // The signature headers the page's risk layer reads: present, and the
      // sign the page itself would compute.
      const { "x-sign": sign, "x-nonce": nonce, "x-timestamp": timestamp } = req.headers
      const expect = createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest("hex")
      if (!sign || !nonce || !timestamp || sign !== expect) {
        return json(res, { code: 10001, message: "invalid signature", result: null })
      }
      if (payload.conversation_id && refuseConversation) {
        return json(res, { code: 40003, message: "conversation not found", result: null })
      }
      if (busyOnce && !busySpent) {
        busySpent = true
        seen.completions.push({ path: url.pathname, payload, busy: true })
        return json(res, { code: 10061, message: "请等待其他对话生成完毕", result: null })
      }
      seen.completions.push({ path: url.pathname, payload })
      let conversationId = payload.conversation_id
      if (!conversationId || !conversations.has(conversationId)) {
        conversationId = `conv-${++conversationCounter}`
        conversations.set(conversationId, { parts: [] })
      }
      const conversation = conversations.get(conversationId)
      if (noStream) {
        return json(res, ok({ conversation_id: conversationId, status: "finish" }))
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" })
      // Frame 1: the turn opens, with the conversation id.
      const partId = `logic-${conversation.parts.length + 1}`
      const frames = []
      if (think) {
        frames.push({ conversation_id: conversationId, status: "init", parts: [{ logic_id: partId, role: "assistant", status: "wip", content: [{ type: "think", think: think.slice(0, 1) }] }] })
        frames.push({ conversation_id: conversationId, status: "init", parts: [{ logic_id: partId, role: "assistant", status: "wip", content: [{ type: "think", think: think }] }] })
      }
      if (searchNotes) {
        frames.push({
          conversation_id: conversationId,
          status: "init",
          parts: [{ logic_id: `${partId}-search`, role: "assistant", status: "wip", content: [{ type: "tool_result", content: [], meta_data: { tool_result_extra: { search_results: [{ title: "A result", url: "https://example.com/a", match_key: "turn1search1" }] } } }] }],
        })
      }
      frames.push({ conversation_id: conversationId, status: "init", parts: [{ logic_id: partId, role: "assistant", status: "wip", content: [{ type: "text", text: reply.slice(0, 1) }] }] })
      frames.push({ conversation_id: conversationId, status: "init", parts: [{ logic_id: partId, role: "assistant", status: "wip", content: [{ type: "text", text: reply.slice(0, Math.max(1, Math.ceil(reply.length / 2))) }] }] })
      frames.push({ conversation_id: conversationId, status: "init", parts: [{ logic_id: partId, role: "assistant", status: "wip", content: [{ type: "text", text: reply }] }] })
      frames.push({ conversation_id: conversationId, status, parts: [{ logic_id: partId, role: "assistant", status: "finish", content: [{ type: "text", text: reply }] }] })
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.write("data: [DONE]\n\n")
      conversation.parts.push(partId)
      res.end()
      return
    }
    return json(res, { code: 404, message: "not found", result: null }, 404)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, seen, conversations, close: () => new Promise((resolve) => server.close(resolve)) }
}

// streamText runs a plugin fetch and folds its SSE back into one string.
export async function streamText(response, { reasoning = false } = {}) {
  const text = await response.text()
  let content = ""
  let thoughts = ""
  let finish = null
  const calls = []
  let error = null
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6)
    if (payload === "[DONE]") continue
    const frame = JSON.parse(payload)
    if (frame.error) {
      error = frame.error.message
      continue
    }
    const choice = frame.choices?.[0]
    if (choice) {
      content += choice.delta?.content ?? ""
      thoughts += choice.delta?.reasoning_content ?? ""
      for (const call of choice.delta?.tool_calls ?? []) calls.push(call)
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }
  const out = { content, finish, calls, error, raw: text }
  return reasoning ? { ...out, thoughts } : out
}
