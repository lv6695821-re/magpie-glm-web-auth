// The web app's own HTTP contract: the page's headers, the signature every
// request carries, the answer envelope and the conversation calls.
//
// chatglm.cn signs each request rather than issuing a proof of work: the page
// computes a checksum digit into its own timestamp (the digit sum with the
// second-to-last dropped, mod 10, replacing the second-to-last digit), pairs
// it with a random hex nonce, and MD5s both with a secret baked into the page
// bundle. This is the page's own arithmetic, reproduced as its client does it;
// the secret travels in the public JS bundle the browser downloads.

import { createHash, randomUUID } from "node:crypto"
import { USER_AGENT, DELETE_PATH } from "./config.mjs"

// The secret from the page's bundle. The page's build can rotate it; if it
// does the plugin's requests fail their signature check and this constant is
// what to update.
const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"

const uuidHex = () => randomUUID().replaceAll("-", "")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The browser face the page sends with every request. The sec-ch-ua headers
// are a coherent set (Edge 143 as the browser the UA names); the page's risk
// layer reads the group as a whole.
function headers(origin, extra = {}) {
  return {
    accept: "text/event-stream",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "app-name": "chatglm",
    "cache-control": "no-cache",
    "content-type": "application/json",
    origin,
    pragma: "no-cache",
    priority: "u=1, i",
    referer: `${origin}/main/alltoolsdetail`,
    "sec-ch-ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": USER_AGENT,
    "x-app-fr": "browser_extension",
    "x-app-platform": "pc",
    "x-app-version": "0.0.1",
    "x-device-brand": "",
    "x-device-model": "",
    "x-lang": "zh",
    ...extra,
  }
}

// signed returns the page's four signature headers for one request: a fresh
// device and request id (the page generates per request), a nonce, and the
// timestamp with its checksum digit folded in.
function signed() {
  const now = String(Date.now())
  const digits = [...now].map(Number)
  const checksum = (digits.reduce((a, b) => a + b, 0) - digits[digits.length - 2]) % 10
  const timestamp = now.slice(0, -2) + checksum + now.slice(-1)
  const nonce = uuidHex()
  const sign = createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest("hex")
  return {
    "x-device-id": uuidHex(),
    "x-request-id": uuidHex(),
    "x-nonce": nonce,
    "x-sign": sign,
    "x-timestamp": timestamp,
  }
}

// json unwrap's chatglm.cn's {code|status, message, result} answer and takes
// the result out; a failure becomes an Error with the code attached.
async function json(response, what, { allow = [] } = {}) {
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`GLM ${what}: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`GLM ${what}: the sign-in was refused — sign in to chatglm.cn again`)
    error.signIn = "expired"
    throw error
  }
  if (!value || typeof value !== "object") throw new Error(`GLM ${what}: unexpected answer`)
  const code = value.code ?? value.status
  const message = value.message ?? value.msg ?? ""
  const ok = code === undefined || code === null || code === 0 || code === "0" || allow.includes(Number(code))
  if (!ok) {
    const error = new Error(`GLM ${what} refused (${code}): ${message || "no reason given"}`)
    error.code = Number(code)
    // 40102 is chatglm.cn's "token expired" business code, surfaced as HTTP 200.
    if (Number(code) === 40102) error.signIn = "expired"
    throw error
  }
  return value.result ?? null
}

// Magpie names every conversation with a title request before it shows one in
// its list: one user message that carries the instructions and the turn to
// summarise. It is not part of the conversation — answering it inside the
// conversation's own chat would file the instructions there — so these are
// served from a conversation of their own, deleted as soon as the title is in.
// Both phrases are magpie's own instructions, verbatim in every title request;
// a user's question that merely mentions titles does not carry them both.
const TITLE_MARKERS = [/generate a concise title for this/i, /return exactly one valid json object/i]

function isTitleRequest(messages) {
  const text = messages?.filter((m) => m?.role === "user").map((m) => (typeof m?.content === "string" ? m.content : "")).join("\n") ?? ""
  return TITLE_MARKERS.every((marker) => marker.test(text))
}

// deleteConversation removes a conversation the page would not keep: the
// title request's one-off chat, or a conversation the account no longer holds.
async function deleteConversation(origin, accessToken, assistantId, conversationId, signal) {
  try {
    const response = await fetch(`${origin}${DELETE_PATH}`, {
      method: "POST",
      headers: headers(origin, { authorization: `Bearer ${accessToken}`, ...signed() }),
      body: JSON.stringify({ assistant_id: assistantId, conversation_id: conversationId }),
      signal,
    })
    await json(response, "conversation delete")
  } catch {
    // a delete that fails leaves a stray conversation behind, nothing worse
  }
}

export { sleep, headers, signed, json, deleteConversation, isTitleRequest, uuidHex, SIGN_SECRET }
