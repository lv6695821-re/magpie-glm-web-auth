// Browser profiles
//
// The sign-in looks for a signed-in chatglm.cn session in the browsers whose
// storage can be read on this machine. The page writes its
// chatglm_refresh_token as a cookie (js-cookie, domain .chatglm.cn) and, in
// some login paths, into Local Storage as well, so both stores are read:
//
//   Cookies     an SQLite database under the profile; Chromium encrypts the
//               cookie value with AES-256-GCM under a key in Local State
//               (DPAPI-wrapped on Windows, Keychain/keyring on the others),
//               Firefox keeps its cookies.sqlite in plain text
//   Local Storage a leveldb whose records hold the key and then the value
//
// The decryption runs through PowerShell's .NET AES-GCM on Windows and OpenSSL
// on macOS/Linux — no native module, no build step. Everything is read, never
// written, and nothing but the token is taken. A browser whose cookie value
// uses Chromium's newer App-Bound encryption (Chrome/Edge 127+ with the
// app-bound flag) decrypts to garbage, and the sign-in says to paste instead.
// Candidates are checked against chatglm.cn; the one that answers is kept.

import { execFileSync } from "node:child_process"
import { createDecipheriv } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { headers, signed } from "./api.mjs"
import { REFRESH_PATH } from "./config.mjs"
import { open as sqliteOpen } from "./sqlite.mjs"

// The Chromium-family browsers, as each names its profile data per platform.
// Every entry is the browser's user-data directory, which holds one directory
// per profile (Default, Profile 1, …).
function browserDataDirs() {
  const home = homedir()
  const names = {
    darwin: [
      "Google/Chrome",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
      "Vivaldi",
      "Arc",
      "Google/Chrome Beta",
      "Google/Chrome Canary",
    ],
    linux: ["google-chrome", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"],
    win32: ["Google/Chrome/User Data", "Chromium/User Data", "BraveSoftware/Brave-Browser/User Data", "Microsoft/Edge/User Data"],
  }
  const base = process.platform === "darwin"
    ? join(home, "Library/Application Support")
    : process.platform === "linux"
      ? join(home, ".config")
      : process.env.LOCALAPPDATA ?? ""
  if (!base) return []
  return (names[process.platform] ?? []).map((name) => join(base, name)).filter((dir) => existsSync(dir))
}

// firefoxDataDirs are the Firefox-family profile roots, whose profiles are
// named .default* / *.default-release and hold a cookies.sqlite in the clear.
function firefoxDataDirs() {
  const home = homedir()
  const names = {
    darwin: ["Firefox", "Waterfox", "LibreWolf"],
    linux: [".mozilla/firefox", ".librewolf", ".waterfox"],
    win32: ["Mozilla/Firefox", "Waterfox", "LibreWolf"],
  }
  const base = process.platform === "darwin"
    ? join(home, "Library/Application Support")
    : process.platform === "linux"
      ? join(home, ".mozilla")
      : process.env.APPDATA ?? ""
  if (!base) return []
  return (names[process.platform] ?? []).map((name) => join(base, name)).filter((dir) => existsSync(dir))
}

// profileDirs are the per-profile directories of a browser's user-data
// directory: only ones that actually carry a Cookies database or a Local
// Storage leveldb.
function profileDirs(dataDir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dataDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // A browser's own data dir can also nest its profiles (Chrome → "User Data").
    if (/^(User Data)$/.test(entry.name)) {
      out.push(...profileDirs(join(dataDir, entry.name)))
      continue
    }
    if (!/^(Default|Profile \d+|Guest Profile|System Profile)$/.test(entry.name)) continue
    const profile = join(dataDir, entry.name)
    if (existsSync(join(profile, "Network/Cookies")) || existsSync(join(profile, "Cookies")) || existsSync(join(profile, "Local Storage/leveldb"))) {
      out.push(profile)
    }
  }
  return out
}

// firefoxProfileDirs are the per-profile directories of a Firefox-family root:
// the ones that actually carry a cookies database.
function firefoxProfileDirs(dataDir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dataDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!/\.default(-release)?$/i.test(entry.name) && !/^Profiles$/i.test(entry.name)) continue
    const profile = entry.name.toLowerCase() === "profiles" ? join(dataDir, entry.name) : join(dataDir, entry.name)
    if (entry.name.toLowerCase() === "profiles") {
      out.push(...firefoxProfileDirs(profile))
      continue
    }
    if (existsSync(join(profile, "cookies.sqlite"))) out.push(profile)
  }
  return out
}

// storageRoots returns every readable profile on this machine, tagged by family:
// {profile, family} with family "chromium" or "firefox", newest profile first.
function storageRoots() {
  const out = []
  for (const dir of browserDataDirs()) for (const profile of profileDirs(dir)) out.push({ profile, family: "chromium" })
  for (const dir of firefoxDataDirs()) for (const profile of firefoxProfileDirs(dir)) out.push({ profile, family: "firefox" })
  return out
}

// chromiumRoots and firefoxRoots keep the older, store-shaped helpers the
// tests and the Local Storage scan use.
function chromiumRoots() {
  return storageRoots().filter((root) => root.family === "chromium").map((root) => join(root.profile, "Local Storage/leveldb")).filter((level) => existsSync(level))
}

const TOKEN_KEYS = ["chatglm_refresh_token", "chatglm_refreshtoken", "chatglm_refreshToken"]

// A chatglm.cn refresh token: the JWT the page writes, `eyJ…` head and two
// dot-separated base64url segments, well over 40 characters.
const TOKEN_VALUE = /eyJ[A-Za-z0-9_-]{20,}(\.[A-Za-z0-9_-]+)*\.[A-Za-z0-9_-]{10,}/g

// collect collects the JWT-shaped runs in a byte window: the run may be
// stored as plain UTF-8 (leveldb keys, Firefox), UTF-16LE (a leveldb value),
// or inside an encrypted blob (Chromium cookies, whose plaintext we already
// decoded before calling). Runs shorter than a token's head are skipped.
function collect(buffer, seen) {
  const asText = (bytes) => {
    TOKEN_VALUE.lastIndex = 0
    const found = TOKEN_VALUE.exec(bytes)
    if (found && !seen.has(found[0])) seen.add(found[0])
  }
  asText(buffer.toString("utf8"))
  // A UTF-16LE-stored value: strip the zero bytes between characters and
  // read what remains as text.
  let j = 0
  const narrow = Buffer.alloc(Math.ceil(buffer.length / 2))
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    if (buffer[i + 1] === 0) narrow[j++] = buffer[i]
  }
  asText(narrow.subarray(0, j).toString("utf8"))
}

// tokenCandidatesFromLevelDb looks for the token keys in a profile's Local
// Storage leveldb files and takes the JWT that trails them. Chromium writes
// the key as plain text and the value right after it in the same record, so
// the first JWT-shaped run after the key is the token; the newest files are
// read first, since the most recent write carries the live one. Only
// key-anchored windows are harvested: a whole-store scan would sweep up other
// sites' tokens (every origin's storage packs into the same leveldb), and a
// token the caller cannot tie to chatglm.cn is worse than no candidate — it
// turns "not signed in" into a misleading "refused". Several candidates can
// come out of a profile; the caller checks them against chatglm.cn and keeps
// the one that answers.
function tokenCandidatesFromLevelDb(dir) {
  let files
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".ldb") || name.endsWith(".log"))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
  files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
  const seen = new Set()
  for (const file of files) {
    let buffer
    try {
      buffer = readFileSync(file)
    } catch {
      continue
    }
    for (const key of TOKEN_KEYS) {
      for (const needle of [Buffer.from(key, "utf8"), Buffer.from(key, "utf16le")]) {
        let at = 0
        while ((at = buffer.indexOf(needle, at)) !== -1) {
          // The value sits just past the key: read a little in and take the
          // first JWT-shaped run (UTF-8 or UTF-16, whichever it is).
          collect(buffer.subarray(at + needle.length, at + needle.length + 8192), seen)
          at += needle.length
        }
      }
    }
  }
  return [...seen]
}

// ---------------------------------------------------------------------------
// Chromium cookies: an SQLite database whose chatglm.cn row holds the token,
// encrypted with AES-256-GCM under a key in the browser's Local State.
// ---------------------------------------------------------------------------

// openDbCopy copies a live SQLite database (the browser holds it locked) to a
// scratch directory and returns the copy's path. WAL and SHM ride along when
// they exist: recent writes live there until a checkpoint. A copy the plain
// read refuses (Windows locks the file while Chrome runs) retries through
// PowerShell's Copy-Item, which opens with the flags a running browser
// tolerates; a database neither reaches reads as absent.
function openDbCopy(dbPath, scratch) {
  const copy = join(scratch, "db.sqlite")
  try {
    copyFileSync(dbPath, copy)
  } catch {
    if (process.platform !== "win32") throw new Error(`the cookies database is locked: ${dbPath}`)
    try {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `Copy-Item -LiteralPath '${dbPath.replaceAll("'", "''")}' -Destination '${copy.replaceAll("'", "''")}' -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath '${copy.replaceAll("'", "''")}')) { exit 1 }`],
        { timeout: 15_000, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
      )
    } catch {
      throw new Error(`the cookies database is locked: ${dbPath}`)
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    const side = dbPath + suffix
    if (!existsSync(side)) continue
    try {
      copyFileSync(side, copy + suffix)
    } catch {
      // a WAL that will not copy rides out: the checkpointed rows still read
    }
  }
  return copy
}

// localStateKey reads a Chromium browser's AES-256-GCM cookie key out of its
// Local State: "os_crypt" → "encrypted_key", DPAPI-wrapped on Windows.
function localStateKey(userdataDir) {
  const path = join(userdataDir, "Local State")
  if (!existsSync(path)) return null
  let state
  try {
    state = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  const wrapped = state?.os_crypt?.encrypted_key
  if (typeof wrapped !== "string" || !wrapped) return null
  let blob
  try {
    blob = Buffer.from(wrapped, "base64")
  } catch {
    return null
  }
  // The blob opens with the five letters "DPAPI" — Edge writes it bare;
  // some Chrome builds carry a 0x01 version byte in front of them. What
  // follows the prefix is DPAPI's to open.
  if (blob.length < 6) return null
  if (blob.subarray(0, 5).toString("latin1") === "DPAPI") return blob.subarray(5)
  if (blob[0] === 1 && blob.subarray(1, 6).toString("latin1") === "DPAPI") return blob.subarray(6)
  return null
}

// dpapiUnwrap opens a DPAPI-protected blob as the current user, through
// PowerShell's ProtectedData.Unprotect. Windows only.
function dpapiUnwrap(blob) {
  if (process.platform !== "win32") return null
  const script = [
    "$in = [Convert]::FromBase64String('" + blob.toString("base64") + "')",
    "Add-Type -AssemblyName System.Security",
    "$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, 'CurrentUser')",
    "[Convert]::ToBase64String($out)",
  ].join("; ")
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    return Buffer.from(String(out).trim(), "base64")
  } catch {
    return null
  }
}

// keychainUnwrap opens the "Chrome Safe Storage" secret on macOS through the
// security CLI; the browser's own keychain entry is what the cookies were
// wrapped with.
function keychainUnwrap(service) {
  if (process.platform !== "darwin") return null
  try {
    const out = execFileSync("security", ["find-generic-password", "-w", "-s", service], { timeout: 10_000 })
    return Buffer.from(String(out).trim(), "utf8")
  } catch {
    return null
  }
}

// gcmDecrypt opens one cookie value: the strip of its version prefix, the 12
// bytes of nonce that follow, and the rest — ciphertext with a 16-byte GCM tag.
function gcmDecrypt(blob, key) {
  for (const prefix of [3, 32]) {
    if (blob.length <= prefix + 12 + 16) continue
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(prefix, prefix + 12))
      decipher.setAuthTag(blob.subarray(blob.length - 16))
      return Buffer.concat([decipher.update(blob.subarray(prefix + 12, blob.length - 16)), decipher.final()])
    } catch {
      // wrong prefix or wrong key: try the other shape
    }
  }
  return null
}

// runSqlite reads a cookies query against one database file through the
// embedded reader (src/sqlite.mjs): no external tool needed. The query is
// one of the two shapes the cookie scanners ask for, named by `kind` —
// "chromium" (name, encrypted_value, value) or "firefox" (value).
function runSqlite(db, kind) {
  const database = sqliteOpen(db)
  if (!database) return null
  const table = database.findTable(kind === "firefox" ? "moz_cookies" : "cookies")
  if (!table) return []
  const rows = database.readRows(kind === "firefox" ? "moz_cookies" : "cookies")
  // The schema's own column order tells the columns apart: Firefox's
  // moz_cookies is (id, originAttributes, name, value, host, …) while
  // Chromium's cookies is (creation_utc, host_key, …, name, value,
  // encrypted_value, …) — and older Chromium schemas drop the
  // top_frame_site_key column between them.
  const columns = (table.sql ?? "")
    .slice(table.sql.indexOf("(") + 1, table.sql.lastIndexOf(")"))
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0].replace(/^"(.*)"$/, "$1"))
  const at = (name) => columns.indexOf(name)
  const out = []
  for (const row of rows) {
    if (kind === "firefox") {
      const host = row[at("host")]
      const name = row[at("name")]
      const value = row[at("value")]
      if (!host || !String(host).includes("chatglm.cn")) continue
      if (!name || !String(name).toLowerCase().includes("refresh")) continue
      if (typeof value === "string" && value) out.push(value)
      else if (value && value.length) collect(Buffer.from(value), out)
    } else {
      const hostKey = row[at("host_key")]
      if (!hostKey || !String(hostKey).includes("chatglm.cn")) continue
      const cookieName = row[at("name")]
      const encryptedValue = row[at("encrypted_value")]
      const plainValue = row[at("value")]
      out.push({
        name: cookieName ?? "",
        encrypted: Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(String(encryptedValue ?? ""), "utf8"),
        plain: typeof plainValue === "string" ? plainValue : "",
      })
    }
  }
  return out
}

// chromiumCookieCandidatesHex reads the chatglm.cn rows of a Chromium
// profile's Cookies database: the values come out of the SQLite CLI as hex,
// are decrypted with the browser's key (DPAPI-opened on Windows, keychain on
// macOS), and the plaintext is scanned for the token. App-Bound encrypted
// values (flag "v20", Chrome/Edge 127+ with the app-bound flag) do not open
// here — they are skipped, and the paste sign-in covers them.
function chromiumCookieCandidatesHex(profile, scratch) {
  void scratch // the reader reads the copied file whole; no scratch needed
  const dbPath = existsSync(join(profile, "Network/Cookies")) ? join(profile, "Network/Cookies") : join(profile, "Cookies")
  if (!existsSync(dbPath)) return []
  let copy
  try {
    copy = openDbCopy(dbPath, scratch)
  } catch {
    // the browser is running and Windows would not yield the file: this
    // profile is skipped, another browser's or the paste sign-in covers it
    return []
  }
  const userdataDir = profile
    .replace(/[\\/]Network$/, "")
    .replace(/[\\/](Default|Profile \d+|Guest Profile|System Profile)$/, "")
  const wrapped = localStateKey(userdataDir)
  const key = (process.platform === "win32" && wrapped ? dpapiUnwrap(wrapped) : null)
    ?? keychainUnwrap("Chrome Safe Storage")
    ?? keychainUnwrap("Chromium Safe Storage")
    ?? keychainUnwrap("Microsoft Edge Safe Storage")
    ?? keychainUnwrap("Brave Safe Storage")
  const rows = runSqlite(copy, "chromium")
  const seen = new Set()
  if (rows !== null) {
    for (const row of rows) {
      // A plain-text value (v10 never set) carries the token as it is.
      if (row.plain) {
        collect(Buffer.from(row.plain, "utf8"), seen)
        continue
      }
      const blob = row.encrypted
      if (!blob || !blob.length) continue
      // The value opens with a version tag: "v10" (AES-GCM), "v20" (App-Bound,
      // not openable here), or nothing (plain bytes).
      const head = blob.subarray(0, 3).toString("latin1")
      if (head === "v20") continue
      let plain = null
      if (head === "v10" && key) plain = gcmDecrypt(blob, key)
      else if (!head.startsWith("v")) plain = blob
      if (plain) collect(plain, seen)
      void row.name
    }
  }
  return [...seen]
}

// firefoxCookieCandidates reads a Firefox profile's cookies.sqlite — plain
// SQLite, no encryption. The value column holds the token as it was set.
function firefoxCookieCandidates(profile, scratch) {
  const dbPath = join(profile, "cookies.sqlite")
  if (!existsSync(dbPath)) return []
  let copy
  try {
    copy = openDbCopy(dbPath, scratch)
  } catch {
    return []
  }
  const rows = runSqlite(copy, "firefox")
  const out = []
  if (rows !== null) {
    for (const value of rows) {
      collect(Buffer.from(value, "utf8"), out)
    }
  }
  return out
}

// tokenFromLevelDb is the first candidate, what a caller that only wants one gets.
function tokenFromLevelDb(dir) {
  return tokenCandidatesFromLevelDb(dir)[0] ?? null
}

// findBrowserToken walks every readable browser profile and returns the first
// chatglm.cn token it finds, with where it came from.
function findBrowserToken() {
  for (const root of storageRoots()) {
    const scratch = mkdtempSync(join(tmpdir(), "glm-cookies-"))
    try {
      const candidates = root.family === "chromium"
        ? [...tokenCandidatesFromLevelDb(join(root.profile, "Local Storage/leveldb")), ...chromiumCookieCandidatesHex(root.profile, scratch)]
        : firefoxCookieCandidates(root.profile, scratch)
      const token = candidates[0]
      if (token) return { token, from: root.profile }
    } catch {
      // an unreadable profile is skipped, not fatal
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return null
}

// browserTokens lists every candidate the machine's profiles hold, newest
// profile first, so a sign-in can try each and keep the one chatglm.cn accepts.
function browserTokens() {
  const out = []
  for (const root of storageRoots()) {
    const scratch = mkdtempSync(join(tmpdir(), "glm-cookies-"))
    try {
      const candidates = root.family === "chromium"
        ? [...tokenCandidatesFromLevelDb(join(root.profile, "Local Storage/leveldb")), ...chromiumCookieCandidatesHex(root.profile, scratch)]
        : firefoxCookieCandidates(root.profile, scratch)
      for (const token of candidates) out.push({ token, from: root.profile })
    } catch {
      // an unreadable profile is skipped, not fatal
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return out
}

// isGuestToken says whether a token is the page's anonymous visitor session:
// the page mints one for every browser it opens, before anyone signs in, and
// its refresh works exactly like a real account's. Only the JWT's is_guest
// flag tells them apart — a token without a parseable payload is taken as a
// real session, so an unexpected payload shape never locks the sign-in out.
function isGuestToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))
    return payload?.is_guest === true
  } catch {
    return false
  }
}

// whoAmI asks the page's own refresh endpoint whether a token is a live
// session: the cheapest call that answers it (one signed POST, no chat). A
// dead token is refused inside the envelope with HTTP 200, so the business
// code is what decides it. A guest session refreshes just as willingly but
// is nobody's sign-in: refused here, so the silent reuse and the window
// sign-in both wait for a real account.
async function whoAmI(origin, refreshToken, signal) {
  if (isGuestToken(refreshToken)) return null
  const response = await fetch(`${origin}${REFRESH_PATH}`, {
    method: "POST",
    headers: headers(origin, { authorization: `Bearer ${refreshToken}`, ...signed() }),
    body: JSON.stringify({}),
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (response.status === 401 || response.status === 403) return null
  const value = await response.json().catch(() => null)
  if (!value || typeof value !== "object") return null
  const code = value.code ?? value.status
  if (code !== undefined && code !== null && code !== 0 && code !== "0") return null
  const result = value.result
  if (!result || typeof result !== "object" || !result.access_token) return null
  // The account's own page shows its name in its settings; the JWT's payload
  // may name it, and when it does not the caller falls back to the label.
  let name = ""
  try {
    const payload = JSON.parse(Buffer.from(refreshToken.split(".")[1], "base64url").toString("utf8"))
    name = typeof payload?.name === "string" ? payload.name : typeof payload?.phone === "string" ? payload.phone : ""
  } catch {
    // a payload that does not parse is the page's business
  }
  return { name }
}

// findLiveBrowserToken is what the sign-in uses: the candidates in a browser
// profile, asked which one is still signed in.
async function findLiveBrowserToken(origin, signal) {
  const candidates = browserTokens()
  for (const candidate of candidates) {
    try {
      const who = await whoAmI(origin, candidate.token, signal)
      if (who) return { ...candidate, who }
    } catch {
      // try the next one
    }
  }
  return null
}

export {
  browserDataDirs,
  firefoxDataDirs,
  profileDirs,
  firefoxProfileDirs,
  storageRoots,
  chromiumRoots,
  localStateKey,
  dpapiUnwrap,
  gcmDecrypt,
  openDbCopy,
  runSqlite,
  chromiumCookieCandidatesHex,
  firefoxCookieCandidates,
  tokenCandidatesFromLevelDb,
  tokenFromLevelDb,
  findBrowserToken,
  browserTokens,
  isGuestToken,
  whoAmI,
  findLiveBrowserToken,
  collect,
}
