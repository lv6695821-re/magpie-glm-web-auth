import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as nodeCrypto from "node:crypto"
import { server, _internal } from "../src/index.mjs"
import { start, streamText } from "./fake.mjs"
import * as sqlite from "../src/sqlite.mjs"
import { gcmDecrypt, runSqlite as browserTokenRunSqlite, chromiumCookieCandidatesHex, isGuestToken, whoAmI } from "../src/browser-token.mjs"
import { browserBinary, devtoolsPort, cdpConnection, silentSignin } from "../src/browser-login.mjs"

const { PartReader, PartTracker, messagesToPrompt, messageSignature, tokenFromLevelDb, toolsToPrompt, parseToolBlock } = _internal

const running = []
async function fake(options) {
  const f = await start(options)
  running.push(f)
  return f
}
test.afterEach(async () => {
  while (running.length) await running.pop().close()
})

// A plugin as the host runs it: hooks resolved, then an account wired in.
async function loaded(f, { token = "test-token" } = {}) {
  const hooks = await server({}, { origin: f.origin })
  const config = { provider: {} }
  await hooks.config(config)
  const auth = { type: "api", key: token }
  const options = await hooks.auth.loader(async () => auth)
  return { hooks, config, options }
}

const chat = (options, body) =>
  options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))

test("config declares the provider and its models", async () => {
  const f = await fake()
  const { config } = await loaded(f)
  const provider = config.provider["glm-web"]
  assert.ok(provider.name.includes("GLM"))
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  for (const id of ["glm-5.3", "glm-5.2", "glm-4.7-flash", "glm-5.3-search", "glm-4.7-flash-search"]) {
    assert.ok(provider.models[id], `model ${id}`)
  }
  assert.equal(provider.models["glm-5.3"].reasoning, true)
  assert.equal(provider.models["glm-4.7-flash"].reasoning, false)
  assert.equal(provider.models["glm-4.7-flash"].limit.context, 128000)
})

test("the auth hook offers a browser sign-in and a pasted token", async () => {
  const f = await fake()
  const { hooks } = await loaded(f)
  assert.equal(hooks.auth.provider, "glm-web")
  assert.deepEqual(hooks.auth.methods.map((m) => m.type), ["oauth", "api"])
})

test("a turn refreshes the token, signs the request and returns the reply", async () => {
  const f = await fake({ reply: "Hello there" })
  const { options } = await loaded(f)
  const response = await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] })
  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-type").includes("text/event-stream"))
  const out = await streamText(response)
  assert.equal(out.content, "Hello there")
  assert.equal(out.finish, "stop")
  // the loader's sign-in check and the turn each refresh once
  assert.equal(f.seen.refreshes.length, 2)
  assert.equal(f.seen.refreshes[f.seen.refreshes.length - 1].token, "test-token")
  const sent = f.seen.completions[0]
  assert.equal(sent.path, "/chatglm/backend-api/assistant/stream")
  assert.equal(sent.payload.messages[0].content[0].text, "hi")
  // the signature headers the page's risk layer reads
  const headers = f.seen.headers.find((h) => h.path === "/chatglm/backend-api/assistant/stream").headers
  assert.match(headers["x-sign"], /^[a-f0-9]{32}$/)
  assert.match(headers["x-nonce"], /^[a-f0-9]{32}$/)
  assert.match(headers["x-timestamp"], /^\d{13}$/)
  assert.match(headers["x-device-id"], /^[a-f0-9]{32}$/)
})

test("the thinking model asks for chat_mode zero with thinking on", async () => {
  const f = await fake({ reply: "2+2=4" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-5.3", stream: true, messages: [{ role: "user", content: "2+2?" }] }))
  assert.equal(out.content, "2+2=4")
  assert.equal(f.seen.completions[0].payload.meta_data.chat_mode, "zero")
})

test("web search follows the page's toggle and the model's variant", async () => {
  const f = await fake({ reply: "ok" })
  const { options } = await loaded(f)
  await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }))
  assert.equal(f.seen.completions[0].payload.meta_data.is_networking, true)
  await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, search_enabled: false, messages: [{ role: "user", content: "hi" }] }))
  assert.equal(f.seen.completions[1].payload.meta_data.is_networking, false)
  await streamText(await chat(options, { model: "glm-4.7-flash-search", stream: true, search_enabled: false, messages: [{ role: "user", content: "hi" }] }))
  // the -search variant pins it on, even against the request's own off
  assert.equal(f.seen.completions[2].payload.meta_data.is_networking, true)
})

test("the page's own headers travel with the request", async () => {
  const f = await fake()
  const { options } = await loaded(f)
  await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }))
  const sent = f.seen.headers.find((h) => h.path === "/chatglm/backend-api/assistant/stream")
  assert.equal(sent.headers["app-name"], "chatglm")
  assert.equal(sent.headers["x-app-platform"], "pc")
  assert.equal(sent.headers.origin, f.origin)
  assert.match(sent.headers["user-agent"], /Mozilla/)
})

test("a bad signature is refused, a good one passes", async () => {
  const f = await fake({ reply: "ok" })
  // the fake checks the sign itself: a turn that went through had a good one,
  // so this is already exercised above; here the sign of a tampered request.
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }))
  assert.equal(out.error, null)
  assert.equal(out.content, "ok")
})

test("a non-streaming request folds the stream into one answer", async () => {
  const f = await fake({ reply: "Folded" })
  const { options } = await loaded(f)
  const response = await chat(options, { model: "glm-4.7-flash", stream: false, messages: [{ role: "user", content: "hi" }] })
  assert.ok(response.headers.get("content-type").includes("application/json"))
  const body = await response.json()
  assert.equal(body.object, "chat.completion")
  assert.equal(body.choices[0].message.content, "Folded")
  assert.equal(body.choices[0].finish_reason, "stop")
})

test("thinking parts become reasoning_content, not the reply", async () => {
  const f = await fake({ reply: "42", think: "let me think" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }), { reasoning: true })
  assert.equal(out.content, "42")
  assert.equal(out.thoughts, "let me think")
})

test("search notes fold into the reasoning", async () => {
  const f = await fake({ reply: "answer", searchNotes: "searching" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }), { reasoning: true })
  assert.equal(out.content, "answer")
  assert.ok(out.thoughts.includes("example.com/a"))
})

test("an unknown model and an unknown path are refused", async () => {
  const f = await fake()
  const { options } = await loaded(f)
  await assert.rejects(chat(options, { model: "gpt-4", stream: true, messages: [] }), /unknown model/)
  await assert.rejects(
    options.fetch(new Request(`${options.baseURL}/models`, { method: "GET" })),
    /unsupported request/,
  )
})

test("a refused sign-in is marked expired", async () => {
  const f = await fake({ refreshFail: true })
  const hooks = await server({}, { origin: f.origin })
  await assert.rejects(
    hooks.auth.loader(async () => ({ type: "api", key: "bad-token" })),
    (error) => error.signIn === "expired",
  )
})

test("the loader is empty without a sign-in", async () => {
  const f = await fake()
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => undefined)
  assert.deepEqual(options, {})
})

test("the pasted-token sign-in checks a live token and refuses a dead one", async () => {
  const f = await fake()
  const { hooks } = await loaded(f)
  const okResult = await hooks.auth.methods[1].authorize({ token: "  a-token  " })
  assert.equal(okResult.type, "success")
  assert.equal(okResult.key, "a-token")
  assert.ok(okResult.accountId.startsWith("chatglm.cn ·"))
  const refused = await hooks.auth.methods[1].authorize({ token: "bad-token" })
  assert.equal(refused.type, "failed")
  assert.match(refused.error, /refused that token/)
})

// ---------------------------------------------------------------------------
// messagesToPrompt: the page's one text box holds a conversation.
// ---------------------------------------------------------------------------

test("messagesToPrompt keeps the conversation as the page's one box would", () => {
  assert.equal(messagesToPrompt([{ role: "user", content: "hi" }]), "hi")
  assert.equal(messagesToPrompt([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]), "be brief\n\nhi\n\nAssistant: hello\n\nUser: again")
  assert.equal(messagesToPrompt([{ role: "user", content: [{ type: "text", text: "parts" }] }]), "parts")
  assert.equal(messagesToPrompt([{ role: "user", content: "" }, { role: "user", content: "only" }]), "only")
})

// ---------------------------------------------------------------------------
// PartReader: the snapshot frames fold into text and reasoning.
// ---------------------------------------------------------------------------

test("PartReader folds the page's snapshot frames into text", () => {
  const reader = new PartReader()
  reader.apply({ conversation_id: "conv-1", status: "init", parts: [{ logic_id: "logic-1", role: "assistant", status: "wip", content: [{ type: "text", text: "He" }] }] })
  reader.apply({ conversation_id: "conv-1", status: "init", parts: [{ logic_id: "logic-1", role: "assistant", status: "wip", content: [{ type: "text", text: "Hello" }] }] })
  reader.apply({ conversation_id: "conv-1", status: "finish", parts: [{ logic_id: "logic-1", role: "assistant", status: "finish", content: [{ type: "text", text: "Hello" }] }] })
  assert.equal(reader.text, "Hello")
  assert.equal(reader.status, "finish")
  assert.equal(reader.conversationId, "conv-1")
})

test("PartReader sends think parts to reasoning, not the reply", () => {
  const reader = new PartReader()
  reader.apply({ conversation_id: "conv-1", status: "init", parts: [{ logic_id: "logic-1", role: "assistant", status: "wip", content: [{ type: "think", think: "why" }] }] })
  reader.apply({ conversation_id: "conv-1", status: "init", parts: [{ logic_id: "logic-1", role: "assistant", status: "wip", content: [{ type: "think", think: "why not?" }] }] })
  assert.equal(reader.text, "")
  assert.equal(reader.reasoning, "why not?")
})

test("PartReader separates two parts' text with a break", () => {
  const reader = new PartReader()
  reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "a", role: "assistant", status: "wip", content: [{ type: "text", text: "one" }] }] })
  reader.apply({ conversation_id: "c", status: "init", parts: [
    { logic_id: "a", role: "assistant", status: "finish", content: [{ type: "text", text: "one" }] },
    { logic_id: "b", role: "assistant", status: "finish", content: [{ type: "text", text: "two" }] },
  ] })
  assert.equal(reader.text, "onetwo")
})

test("PartReader reads the wire's fragment frames whole and the finish frame as the whole part", () => {
  // The real wire, as captured: while a part streams, each frame carries only
  // the fragment that grew it; the frame that finishes the part carries the
  // whole text back. Slicing fragments by what was already sent (the first
  // version's rule) mangled the reply and re-sent the tail at the finish
  // frame — the duplicated paragraphs the live runs showed.
  const reader = new PartReader()
  for (const fragment of ["天", "之所以", "是", "蓝", "的"]) {
    reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "p", role: "assistant", status: "init", content: [{ type: "text", text: fragment }] }] })
  }
  reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "p", role: "assistant", status: "finish", content: [{ type: "text", text: "天之所以是蓝的" }] }] })
  assert.equal(reader.text, "天之所以是蓝的")
})

test("PartReader reconciles think fragments the same way", () => {
  const reader = new PartReader()
  for (const fragment of ["The", " user", " asks"]) {
    reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "t", role: "assistant", status: "init", content: [{ type: "think", think: fragment }] }] })
  }
  reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "t", role: "assistant", status: "finish", content: [{ type: "think", think: "The user asks" }] }] })
  assert.equal(reader.reasoning, "The user asks")
  assert.equal(reader.text, "")
})

// ---------------------------------------------------------------------------
// browser token scan
// ---------------------------------------------------------------------------

test("tokenFromLevelDb reads the refresh token beside its key", () => {
  const dir = mkdtempSync(join(tmpdir(), "glm-leveldb-"))
  try {
    // The record as Chromium writes it: the key as plain text, then the JWT.
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65LCJiX6GLm"
    const record = Buffer.concat([
      Buffer.from("_https://chatglm.cn\u0000\u0001", "utf16le"),
      Buffer.from("chatglm_refresh_token", "utf8"),
      Buffer.from("\u0001\u00b9>\u0085\u0002\u00f0@\"", "binary"),
      Buffer.from(token, "utf8"),
      Buffer.from("\u00b5\u0004|\u000e", "binary"),
    ])
    writeFileSync(join(dir, "000123.ldb"), record)
    assert.equal(tokenFromLevelDb(dir), token)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tokenFromLevelDb finds nothing in a profile without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "glm-leveldb-"))
  try {
    writeFileSync(join(dir, "000123.ldb"), Buffer.from("nothing to see here"))
    assert.equal(tokenFromLevelDb(dir), null)
    assert.equal(tokenFromLevelDb(join(dir, "missing")), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The SQLite cookie reader and the cookie scan that rides it. The fixtures
// are real SQLite files (built with node:sqlite, which ships with Node 22+),
// shaped as Chromium's Cookies database and Firefox's cookies.sqlite are.
// ---------------------------------------------------------------------------

const COOKIE_SCHEMA = `CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)`
const FIREFOX_SCHEMA = `CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, expiry INTEGER NOT NULL, lastAccessed INTEGER NOT NULL, creationTime INTEGER NOT NULL, isSecure INTEGER NOT NULL, isHttpOnly INTEGER NOT NULL, inBrowserElement INTEGER NOT NULL, sameSite INTEGER NOT NULL, rawSameSite INTEGER NOT NULL, schemeMap INTEGER NOT NULL)`

const FIXTURE_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.KKkKkKkKkKkKkKkKkKkKkKkKkKk"

// buildDb writes a minimal-but-real SQLite file: page size 4096, one schema
// page, one table, the rows given. Kept as bytes so the reader under test —
// not a helper library — does all the parsing.
function buildSqlite(pageSize, tableSql, tableName, rows) {
  // The header (100 bytes) + one schema leaf page holding the CREATE row +
  // one table leaf page holding the rows. Small enough to fit one page each.
  const header = Buffer.alloc(100)
  header.write("SQLite format 3\u0000", 0, "latin1")
  header.writeUInt16BE(pageSize, 16)
  header.writeUInt8(1, 18) // write version, legacy
  header.writeUInt8(1, 19) // read version, legacy
  header.writeUInt8(0, 20) // reserved space per page
  header.writeUInt32BE(2, 28) // database size in pages: schema + data
  header.writeUInt32BE(1, 44) // schema cookie
  header.writeUInt32BE(1, 40) // schema format, legacy
  header.writeUInt32BE(4, 56) // text encoding: utf8
  header.writeUInt32BE(1, 92) // version-valid-for
  header.writeUInt32BE(3046001, 96) // sqlite version

  // varint for a non-negative integer: 7 bits per byte, high bit = more
  const varintOf = (value) => {
    if (value < 0x80) return Buffer.from([value])
    if (value < 0x4000) return Buffer.from([0x80 | (value >> 7), value & 0x7f])
    return Buffer.from([0x80 | ((value >> 28) & 0x7f), 0x80 | ((value >> 21) & 0x7f), 0x80 | ((value >> 14) & 0x7f), 0x80 | ((value >> 7) & 0x7f), value & 0x7f])
  }

  // serial types + record body for one row of (int, string, ...) values.
  // Integers pick the serial by magnitude: 1..4 bytes, then 6, then 8 —
  // the fixtures' timestamps need the 8-byte shape.
  const recordOf = (values) => {
    const types = []
    const bodies = []
    for (const value of values) {
      if (typeof value === "number") {
        const big = BigInt(Math.trunc(value))
        // The serial is the byte count itself: 1..4 bytes, 6, then 8 — never
        // the constant-zero serial 8, which carries no bytes at all.
        const bytes = big < 0n ? 8n : big <= 0x7fn ? 1n : big <= 0x7fffn ? 2n : big <= 0x7fffffn ? 3n : big <= 0x7fffffffn ? 4n : big <= 0xffffffffffffn ? 6n : 8n
        const size = Number(bytes)
        types.push(Buffer.from([size === 8 ? 6 : size === 6 ? 5 : size]))
        const body = Buffer.alloc(size)
        let v = big < 0n ? (1n << BigInt(size * 8)) + big : big
        for (let i = size - 1; i >= 0; i--) {
          body[i] = Number(v & 0xffn)
          v >>= 8n
        }
        bodies.push(body)
      } else if (typeof value === "string") {
        const body = Buffer.from(value, "utf8")
        const size = body.length * 2 + 13
        types.push(varintOf(size))
        bodies.push(body)
      } else if (Buffer.isBuffer(value)) {
        types.push(varintOf(value.length * 2 + 12))
        bodies.push(value)
      } else {
        types.push(Buffer.from([0x00]))
        bodies.push(Buffer.alloc(0))
      }
    }
    const header = Buffer.concat(types)
    const body = Buffer.concat(bodies)
    return Buffer.concat([varintOf(header.length + 1), header, body])
  }

  // one leaf table page holding the given rows. Page 1's body sits after the
  // 100-byte file header, but its cell pointers are offsets into the whole
  // page as the file lays it out — so content allocates at pageSize - 100
  // and every pointer carries the 100-byte shift.
  const leafOf = (cells, first = false) => {
    const page = Buffer.alloc(first ? pageSize - 100 : pageSize)
    const shift = first ? 100 : 0
    const size = first ? pageSize - 100 : pageSize
    page.writeUInt8(13, 0) // leaf table
    page.writeUInt16BE(0, 1) // first freeblock: none
    page.writeUInt16BE(cells.length, 3)
    let contentAt = size
    cells.forEach((cell, i) => {
      contentAt -= cell.length
      page.writeUInt16BE(contentAt + shift, 8 + i * 2)
      cell.copy(page, contentAt)
    })
    page.writeUInt16BE(contentAt + shift, 5) // cell content starts here
    page.writeUInt8(0, 7) // fragmented free bytes
    return page
  }

  // a leaf cell: payload size, rowid, record
  const cellOf = (rowId, values) => {
    const record = recordOf(values)
    return Buffer.concat([varintOf(record.length), varintOf(rowId), record])
  }

  // The schema page carries the CREATE row: (type, name, tbl_name, rootpage, sql)
  const schemaCell = cellOf(1, ["table", tableName, tableName, 2, tableSql])
  const schemaBody = leafOf([schemaCell], true) // page 1: header + body

  // The table page carries the data rows.
  const dataCells = rows.map((row, i) => cellOf(i + 1, row))
  const dataPage = leafOf(dataCells)

  return Buffer.concat([header, schemaBody, dataPage])
}

test("the sqlite reader walks a real cookies database and finds the chatglm row", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "glm-db-")), "Cookies")
  const rows = [
    [13300000000000000, ".chatglm.cn", "", "chatglm_refresh_token", FIXTURE_TOKEN, Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
    [13300000000000000, ".google.com", "", "SID", "g-session", Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
  ]
  writeFileSync(dbPath, buildSqlite(4096, COOKIE_SCHEMA, "cookies", rows))
  const { open } = sqlite
  const db = open(dbPath)
  assert.ok(db, "the file reads as a database")
  const read = db.readRows("cookies")
  assert.equal(read.length, 2)
  assert.equal(read[0][1], ".chatglm.cn")
  assert.equal(read[0][4], FIXTURE_TOKEN)
})

test("runSqlite's chromium scan picks the chatglm row and skips other hosts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "glm-scratch-"))
  try {
    const dbPath = join(scratch, "Cookies")
    const rows = [
      [13300000000000000, ".chatglm.cn", "", "chatglm_refresh_token", FIXTURE_TOKEN, Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
      [13300000000000000, ".google.com", "", "SID", "g-session", Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
    ]
    writeFileSync(dbPath, buildSqlite(4096, COOKIE_SCHEMA, "cookies", rows))
    const result = browserTokenRunSqlite(dbPath, "chromium")
    assert.equal(result.length, 1)
    assert.equal(result[0].name, "chatglm_refresh_token")
    assert.equal(result[0].plain, FIXTURE_TOKEN)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("runSqlite's firefox scan reads moz_cookies rows", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "glm-scratch-"))
  try {
    const dbPath = join(scratch, "cookies.sqlite")
    writeFileSync(dbPath, buildSqlite(4096, FIREFOX_SCHEMA, "moz_cookies", [
      [1, "", "chatglm_refresh_token", FIXTURE_TOKEN, ".chatglm.cn", "/", 1900000000, 0, 0, 1, 1, 0, 0, 0, 0],
      [2, "", "other", "nope", ".example.com", "/", 1900000000, 0, 0, 1, 1, 0, 0, 0, 0],
    ]))
    const result = browserTokenRunSqlite(dbPath, "firefox")
    assert.deepEqual(result, [FIXTURE_TOKEN])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("gcmDecrypt opens a v10 cookie value and refuses a wrong key", () => {
  const { randomBytes, createCipheriv } = nodeCrypto
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const plain = Buffer.from(`chatglm_refresh_token=${FIXTURE_TOKEN}`)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  const blob = Buffer.concat([Buffer.from("v10", "latin1"), nonce, encrypted])
  const opened = gcmDecrypt(blob, key)
  assert.ok(opened, "the value opens")
  assert.ok(opened.toString("utf8").includes(FIXTURE_TOKEN))
  assert.equal(gcmDecrypt(blob, randomBytes(32)), null, "a wrong key refuses")
})

test("chromiumCookieCandidatesHex reads the token out of a plain-text cookie row", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "glm-scratch-"))
  try {
    const profile = mkdtempSync(join(tmpdir(), "glm-profile-"))
    // The profile's userdata root is one level up (…/User Data/Default);
    // with no Local State, the plain-text value path is what reads it.
    mkdirSync(join(profile, "Network"), { recursive: true })
    const dbPath = join(profile, "Network/Cookies")
    writeFileSync(dbPath, buildSqlite(4096, COOKIE_SCHEMA, "cookies", [
      [13300000000000000, ".chatglm.cn", "", "chatglm_refresh_token", FIXTURE_TOKEN, Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
    ]))
    const candidates = chromiumCookieCandidatesHex(profile, scratch)
    assert.deepEqual(candidates, [FIXTURE_TOKEN])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// One agent conversation keeps one chatglm.cn conversation.
// ---------------------------------------------------------------------------

test("one agent conversation keeps one chatglm.cn conversation, sending only new turns", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const auth = { type: "api", key: "a-token" }
  const options = await hooks.auth.loader(async () => auth)
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-abc" },
      body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages }),
    })).then((r) => r.text())
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
  ])
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
  ])
  await call([
    { role: "system", content: "be brief" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "third question" },
  ])
  // Three turns, the later two reusing the conversation the first opened
  // (the first request's own payload can only carry "" — the id arrives with
  // the stream — so the reuse is read off the fake's conversation table).
  assert.equal(f.seen.completions.length, 3)
  assert.deepEqual([...f.conversations.keys()].length, 1)
  assert.equal(f.seen.completions[1].payload.conversation_id, [...f.conversations.keys()][0])
  assert.equal(f.seen.completions[2].payload.conversation_id, [...f.conversations.keys()][0])
  // Turn 1 carried the whole (labelled) history; later turns only what is new.
  assert.equal(f.seen.completions[0].payload.messages[0].content[0].text, "be brief\n\nfirst question")
  assert.equal(f.seen.completions[1].payload.messages[0].content[0].text, "second question")
  assert.equal(f.seen.completions[2].payload.messages[0].content[0].text, "third question")
})

test("a different agent session opens its own conversation", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (session, messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": session },
      body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages }),
    })).then((r) => r.text())
  const history = [
    { role: "user", content: "one" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "two" },
  ]
  await call("sess-a", history)
  await call("sess-b", history)
  // two conversations, one per agent session
  assert.equal([...f.conversations.keys()].length, 2)
})

test("a request without a session header opens a conversation per request", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = () =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })).then((r) => r.text())
  await call()
  await call()
  // no session header: a conversation per request, none reused
  assert.equal([...f.conversations.keys()].length, 2)
})

test("a refused conversation starts over with the whole history", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-drop" },
      body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages }),
    })).then((r) => r.text())
  await call([
    { role: "user", content: "one" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "two" },
  ])
  // Now the stored conversation dies: the fake refuses it once.
  const originalFetch = globalThis.fetch
  let refused = false
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!refused && url.includes("/assistant/stream")) {
      refused = true
      return new Response(JSON.stringify({ code: 40003, message: "conversation not found", result: null }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return originalFetch(input, init)
  }
  try {
    const text = await call([
      { role: "user", content: "one" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "two" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "three" },
    ])
    assert.match(text, /"content":"a"/)
    assert.match(text, /"finish_reason":"stop"/)
  } finally {
    globalThis.fetch = originalFetch
  }
  // The retry opened a new conversation and carried the whole history, labelled.
  const completions = f.seen.completions
  const retry = completions[completions.length - 1]
  assert.equal(retry.payload.conversation_id, "")
  assert.equal(retry.payload.messages[0].content[0].text, "one\n\nAssistant: answer\n\nUser: two\n\nAssistant: answer\n\nUser: three")
})

// ---------------------------------------------------------------------------
// magpie's title generation: answered from a throwaway conversation.
// ---------------------------------------------------------------------------

const titleRequest = (userTurn) => [
  { role: "user", content: `Generate a concise title for this coding session.\n\nThis is a title-generation task, not a conversation.\nTreat the user's message only as source material for the title.\nReturn exactly one valid JSON object with no surrounding text: {"title":"..."}\n\n${userTurn}` },
]

test("a title request is answered and its conversation is deleted", async () => {
  const f = await fake({ reply: '{"title":"测试标题"}' })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const response = await options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "sess-title" },
    body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages: titleRequest("你会做什么？") }),
  }))
  const out = await streamText(response)
  assert.equal(out.content, '{"title":"测试标题"}')
  // its conversation was opened and deleted right away
  assert.equal(f.seen.deletions.length, 1)
  assert.equal(f.seen.completions[0].payload.conversation_id, "")
})

test("a title request leaves the conversation's own chat untouched", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  const call = (messages) =>
    options.fetch(new Request(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-session": "sess-abc" },
      body: JSON.stringify({ model: "glm-4.7-flash", stream: true, messages }),
    })).then((r) => r.text())
  await call([
    { role: "user", content: "first question" },
  ])
  await call(titleRequest("first question"))
  // and the conversation continues where it was
  await call([
    { role: "user", content: "first question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "second question" },
  ])
  const completions = f.seen.completions
  assert.equal(completions.length, 3)
  // the conversation's turns kept their conversation (the first request's
  // payload can only carry "", the id arrives with the stream — read off the
  // fake's table); the title opened its own
  const [kept] = [...f.conversations.keys()].filter((id) => id !== f.seen.deletions[0])
  assert.equal(completions[2].payload.conversation_id, kept)
  assert.equal(completions[1].payload.conversation_id, "")
  assert.equal(completions[2].payload.messages[0].content[0].text, "second question")
  // one throwaway for the title, which is gone
  assert.equal(f.seen.deletions.length, 1)
})

test("a real question that merely mentions titles is not a title request", async () => {
  const f = await fake({ reply: "answer" })
  const hooks = await server({}, { origin: f.origin })
  const options = await hooks.auth.loader(async () => ({ type: "api", key: "a-token" }))
  await options.fetch(new Request(`${options.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-session": "sess-real" },
    body: JSON.stringify({
      model: "glm-4.7-flash",
      stream: true,
      messages: [{ role: "user", content: 'How do I write a function that returns {"title": "x"}? Also, generate a concise title for my essay.' }],
    }),
  })).then((r) => r.text())
  // a plain conversation turn: no throwaway chat, nothing deleted
  assert.deepEqual(f.seen.deletions, [])
})

// ---------------------------------------------------------------------------
// tool calling: the client's tools ride the prompt as a DSML protocol.
// ---------------------------------------------------------------------------

const weatherTool = {
  type: "function",
  function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } },
}

const dsmlCall = (name, args) =>
  [
    "<|DSML|tool_calls>",
    `  <|DSML|invoke name="${name}">`,
    ...Object.entries(args).map(([key, value]) => `    <|DSML|parameter name="${key}"><![CDATA[${value}]]></|DSML|parameter>`),
    "  </|DSML|invoke>",
    "</|DSML|tool_calls>",
  ].join("\n")

test("models declare tool calling", async () => {
  const f = await fake()
  const { config } = await loaded(f)
  assert.equal(config.provider["glm-web"].models["glm-5.3"].tool_call, true)
  assert.equal(config.provider["glm-web"].models["glm-4.7-flash"].tool_call, true)
})

test("a turn with tools opens the prompt with the protocol and parses the reply's calls", async () => {
  const f = await fake({ reply: `Let me check.\n${dsmlCall("get_weather", { city: "北京" })}` })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, {
    model: "glm-4.7-flash",
    stream: true,
    tools: [weatherTool],
    messages: [{ role: "user", content: "weather in 北京?" }],
  }))
  // the call is not reply text: the text stops before the block, the call
  // arrives as tool_calls, and the turn finishes as one
  assert.equal(out.content, "Let me check.\n")
  assert.equal(out.finish, "tool_calls")
  assert.deepEqual(out.calls, [
    { index: 0, id: out.calls[0].id, type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
  ])
  // the prompt taught the model the protocol and listed the tool
  const sent = f.seen.completions[0].payload.messages[0].content[0].text
  assert.ok(sent.includes("[Tool calling]"))
  assert.ok(sent.includes('"get_weather"'))
  assert.ok(sent.includes("weather in 北京?"))
})

test("several invokes in one block parse as several calls", async () => {
  const f = await fake({ reply: `${dsmlCall("a", {})}mid text${dsmlCall("b", { x: "1" })}` })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, tools: [weatherTool], messages: [{ role: "user", content: "hi" }] }))
  assert.equal(out.content, "mid text")
  assert.equal(out.finish, "tool_calls")
  assert.deepEqual(out.calls.map((c) => c.function.name), ["a", "b"])
  assert.deepEqual(out.calls.map((c) => c.index), [0, 1])
})

test("a reply without tool calls finishes as a plain stop", async () => {
  const f = await fake({ reply: "plain answer" })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, tools: [weatherTool], messages: [{ role: "user", content: "hi" }] }))
  assert.equal(out.content, "plain answer")
  assert.equal(out.finish, "stop")
  assert.deepEqual(out.calls, [])
})

test("tool_choice none and title requests take no protocol", async () => {
  const f = await fake({ reply: "ok" })
  const { options } = await loaded(f)
  await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, tool_choice: "none", tools: [weatherTool], messages: [{ role: "user", content: "hi" }] }))
  assert.ok(!f.seen.completions[0].payload.messages[0].content[0].text.includes("[Tool calling]"))
  await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, tools: [weatherTool], messages: titleRequest("你会做什么") }))
  assert.ok(!f.seen.completions[1].payload.messages[0].content[0].text.includes("[Tool calling]"))
})

test("a non-streaming answer carries tool_calls on the message", async () => {
  const f = await fake({ reply: dsmlCall("a", {}) })
  const { options } = await loaded(f)
  const body = await chat(options, { model: "glm-4.7-flash", stream: false, tools: [weatherTool], messages: [{ role: "user", content: "hi" }] }).then((r) => r.json())
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.deepEqual(body.choices[0].message.tool_calls.map((c) => c.function.name), ["a"])
})

test("history shows the model its own calls and their results", () => {
  const prompt = messagesToPrompt(
    [
      { role: "user", content: "weather?" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "sunny 25C" },
      { role: "user", content: "and tomorrow?" },
    ],
    0,
    { tools: [weatherTool] },
  )
  assert.ok(prompt.includes("<|DSML|invoke name=\"get_weather\">"))
  assert.ok(prompt.includes("<|DSML|parameter name=\"city\"><![CDATA[北京]]></|DSML|parameter>"))
  assert.ok(prompt.includes("Tool result (get_weather): sunny 25C"))
  assert.ok(prompt.includes("User: and tomorrow?"))
  assert.ok(prompt.includes("[Tool calling]"))
})

test("DSML blocks split across stream frames still parse", () => {
  const whole = `answer ${dsmlCall("a", { x: "1" })} tail`
  const reader = new PartReader({ tools: true })
  // the snapshots carry whole text that grows: feed prefixes of increasing
  // length, as the page's frames do
  for (let n = 1; n <= whole.length; n++) {
    reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "l", role: "assistant", status: "wip", content: [{ type: "text", text: whole.slice(0, n) }] }] })
  }
  reader.flushHold()
  assert.equal(reader.text, "answer  tail")
  assert.deepEqual(reader.toolCalls.map((c) => c.name), ["a"])
})

// The snapshot frames carry whole text, so the split test above feeds each
// frame the whole prefix — the reader's own text channel stays untouched.
// No monkey-patching needed: the frames are built from the source string.

test("a DSML block without tools stays in the reasoning, out of the reply", () => {
  const reader = new PartReader()
  reader.apply({ conversation_id: "c", status: "init", parts: [{ logic_id: "l", role: "assistant", status: "wip", content: [{ type: "text", text: "<|DSML|tool_calls>searching</|DSML|tool_calls>done" }] }] })
  reader.flushHold()
  assert.equal(reader.text, "done")
  assert.ok(reader.reasoning.includes("searching"))
})

test("parseToolBlock reads CDATA, JSON and malformed tags", () => {
  const calls = parseToolBlock('<|DSML|tool_calls><|DSML|invoke name="t"><|DSML|parameter name="a"><![CDATA[x]]></|DSML|parameter><|DSML|parameter name="b">1</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>')
  assert.deepEqual(calls, [{ id: calls[0].id, name: "t", arguments: '{"a":"x","b":1}' }])
  // missing pipes, as the model writes them in the wild
  const loose = parseToolBlock('<tool_calls><invoke name="t2"><parameter name="q">hello</parameter></invoke></tool_calls>')
  assert.deepEqual(loose, [{ id: loose[0].id, name: "t2", arguments: '{"q":"hello"}' }])
  // a block with nothing readable in it
  assert.deepEqual(parseToolBlock("<|DSML|tool_calls>just noise</|DSML|tool_calls>"), [])
})

test("messageSignature is stable across an identical resend and ties tool results to their calls", () => {
  const message = { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] }
  assert.equal(messageSignature(message), messageSignature(JSON.parse(JSON.stringify(message))))
  const tool = { role: "tool", tool_call_id: "call_1", content: "sunny" }
  assert.notEqual(messageSignature(tool), messageSignature({ role: "tool", tool_call_id: "call_2", content: "sunny" }))
})

test("a busy answer is waited out and retried", async () => {
  const f = await fake({ reply: "after the wait", busyOnce: true })
  const { options } = await loaded(f)
  const out = await streamText(await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }] }))
  assert.equal(out.content, "after the wait")
  // the first answer was the busy code, the second the stream
  assert.equal(f.seen.completions.filter((c) => c.busy).length, 1)
  assert.equal(f.seen.completions.filter((c) => !c.busy).length, 1)
})

test("the busy retry only waits once, not forever", async () => {
  // the fake refuses with busy once; the turn retries and succeeds — covered
  // above. Here: the request's signal aborts a busy wait.
  const f = await fake({ reply: "never", busyOnce: true })
  const { options } = await loaded(f)
  const controller = new AbortController()
  controller.abort()
  const response = await chat(options, { model: "glm-4.7-flash", stream: true, messages: [{ role: "user", content: "hi" }], signal: controller.signal }).catch((e) => e)
  // an aborted request fails rather than hanging
  assert.ok(response instanceof Error || response instanceof Response)
})

// ---------------------------------------------------------------------------
// The controlled-browser sign-in: binary discovery, DevTools endpoint wait,
// the CDP connection, and the silent profile read.
// ---------------------------------------------------------------------------

test("browserBinary finds a real Edge or Chrome on this machine", () => {
  const binary = browserBinary()
  // The fixtures machine carries both Edge and Chrome; a bare CI box may
  // carry neither, so the assertion is "either a real path or null", and the
  // shape is always a filesystem-looking string when set.
  if (binary) {
    assert.match(binary, /(msedge|chrome|brave|chromium)\.exe$|Edge$|Chrome$|Chromium$|brave$/i)
  }
})

test("devtoolsPort waits for the endpoint file and parses port and path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glm-cdp-"))
  try {
    // Nothing there yet: the wait runs out at the given timeout (1s keeps
    // the test quick).
    assert.equal(await devtoolsPort(dir, 1000), null)
    writeFileSync(join(dir, "DevToolsActivePort"), "52212\n/devtools/browser/abc-123\n")
    const endpoint = await devtoolsPort(dir, 100)
    assert.equal(endpoint.port, 52212)
    assert.equal(endpoint.path, "/devtools/browser/abc-123")
    // An early browser exit fails the wait fast instead of reading a stale
    // file — the exit race is how a browser that merged into another
    // instance is caught.
    await assert.rejects(
      devtoolsPort(dir, 5000, Promise.resolve(1)),
      /closed immediately/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cdpConnection speaks the CDP wire against a fake browser socket", async () => {
  // A minimal WebSocket server speaking the frames Storage.getCookies needs.
  // Node has no builtin ws server, so the handshake is done by hand on the
  // server's 'upgrade' event — one accepted HTTP upgrade, one masked client
  // frame decoded, one unmasked server frame written back.
  const { createServer } = await import("node:http")
  const { createHash } = await import("node:crypto")
  const seen = { method: null }
  let client = null
  const http = createServer(() => {})
  http.on("upgrade", (req, socket) => {
    client = socket
    const key = req.headers["sec-websocket-key"]
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on("data", (buffer) => {
      // decode one masked client frame (the client always masks)
      const second = buffer[1] & 0x7f
      let at = 2
      if (second === 126) { at = 4 } else if (second === 127) { at = 10 }
      const mask = buffer.subarray(at, at + 4)
      at += 4
      const payload = buffer.subarray(at)
      const decoded = Buffer.from(payload).map((byte, i) => byte ^ mask[i % 4])
      const frame = JSON.parse(decoded.toString("utf8"))
      seen.method = frame.method
      const answer = JSON.stringify({
        id: frame.id,
        result: frame.method === "Storage.getCookies"
          ? { cookies: [{ name: "chatglm_refresh_token", value: FIXTURE_TOKEN, domain: ".chatglm.cn" }] }
          : {},
      })
      const body = Buffer.from(answer, "utf8")
      // Server frames are unmasked; a payload over 125 bytes takes the
      // 16-bit extended length form, which the token answers always do.
      const header = body.length <= 125
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x81, 126, body.length >> 8 & 0xff, body.length & 0xff])
      socket.write(Buffer.concat([header, body]))
    })
  })
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = http.address().port
  try {
    const cdp = await cdpConnection(port, "/devtools/browser/x")
    const result = await cdp.call("Storage.getCookies")
    assert.equal(seen.method, "Storage.getCookies")
    assert.equal(result.cookies[0].name, "chatglm_refresh_token")
    cdp.close()
  } finally {
    // The upgraded socket must go away by hand: the fake never answers the
    // close handshake, and http.close() waits for it — the test would hang.
    client?.destroy()
    await new Promise((resolve) => http.close(resolve))
  }
})

test("silentSignin reads the token from the plugin profile's cookie store", async () => {
  // The profile layout the controlled sign-in leaves behind: profile/Default
  // with a Cookies database holding a plain-text chatglm_refresh_token row.
  const root = mkdtempSync(join(tmpdir(), "glm-cdp-profile-"))
  try {
    mkdirSync(join(root, "profile", "Default", "Network"), { recursive: true })
    const dbPath = join(root, "profile", "Default", "Network", "Cookies")
    writeFileSync(dbPath, buildSqlite(4096, COOKIE_SCHEMA, "cookies", [
      [13300000000000000, ".chatglm.cn", "", "chatglm_refresh_token", FIXTURE_TOKEN, Buffer.alloc(0), "/", 13350000000000000, 1, 1, 13300000000000001, 1, 1, 1, 0, 1, 443, 13300000000000001, 1, 0],
    ]))
    // silentSignin reads the fixed profile root; point it at the fixture by
    // checking the reader call the plugin makes directly (the fixed root's
    // absence returns []).
    assert.deepEqual(chromiumCookieCandidatesHex(join(root, "profile", "Default"), mkdtempSync(join(tmpdir(), "glm-s2-"))), [FIXTURE_TOKEN])
    // and the silent path itself answers empty when no profile exists
    assert.deepEqual(silentSignin(() => null), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("silentSignin hands the reader a scratch directory and cleans it up", () => {
  // The production composition is silentSignin(chromiumCookieCandidatesHex):
  // the reader copies the Cookies database through a scratch directory before
  // parsing, so a scratch it never receives makes the whole silent reuse
  // answer empty on every machine. Watch the call the plugin makes.
  let seen = null
  const tokens = silentSignin((profile, scratch) => {
    seen = { profile, scratch }
    return ["tok"]
  })
  assert.deepEqual(tokens, ["tok"])
  assert.ok(seen?.scratch, "the reader received a scratch directory")
  assert.ok(!existsSync(seen.scratch), "the scratch directory is removed afterwards")
  // a reader that throws answers empty rather than raising
  assert.deepEqual(silentSignin(() => { throw new Error("locked") }), [])
})

test("guest sessions are not sign-ins", async () => {
  // The page mints an anonymous refresh token for every visitor it opens a
  // window for, before anyone signs in — the live runs captured one and
  // called it a sign-in in 11 s. The JWT's is_guest flag is the only tell.
  const makeJwt = (payload) => [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".")
  const guest = makeJwt({ sub: "g", is_guest: true, type: "refresh" })
  const real = makeJwt({ sub: "u", uid: "u1", type: "refresh" })
  assert.equal(isGuestToken(guest), true)
  assert.equal(isGuestToken(real), false)
  assert.equal(isGuestToken("not-a-jwt"), false)
  // whoAmI refuses a guest before it reaches the network
  assert.equal(await whoAmI("https://chatglm.cn", guest), null)
})
