// The controlled-browser sign-in, the way the DSH plugins do it: the plugin
// launches the machine's own Edge or Chrome against a profile of its own —
// never the browser the user is running, whose cookie files are locked and
// app-bound encrypted — opens chatglm.cn in it, and watches the session for
// the page's chatglm_refresh_token cookie while the user signs in. The
// browser speaks CDP over a WebSocket (Node carries one), so no automation
// library rides along.
//
// The profile persists under the plugin's own directory, so the next sign-in
// reads the token straight out of its cookie store — the same sqlite reader
// browser-token.mjs uses — without opening a window at all.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { isGuestToken } from "./browser-token.mjs"

// The profile lives with the user, across plugin reinstalls.
function profileRoot() {
  return join(homedir(), ".magpie-glm-web-auth")
}

function defaultProfileDir() {
  return join(profileRoot(), "profile", "Default")
}

// browserBinary finds the machine's own Chromium-family browser, Edge first —
// the page's login is what the user does daily in their Edge, and the browser
// binary is not flagged as automated the way a bundled Chromium is.
function browserBinary() {
  const candidates = process.platform === "win32"
    ? [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/Application/msedge.exe"),
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
        "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : ["/usr/bin/msedge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/brave", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  return candidates.filter(Boolean).find((path) => existsSync(path)) ?? null
}

// devtoolsPort waits for the browser to write its DevToolsActivePort file —
// the endpoint the WebSocket connects to — and returns {port, path}. The file
// carries the port on its first line and the browser-level path on the second.
// A file left over from a killed attempt must not be mistaken for this run's
// endpoint: the caller deletes it before the browser starts, and the wait
// here requires a file written fresh. An early browser exit (it merged into
// another instance, or refused the profile) fails fast instead of waiting.
async function devtoolsPort(userDataDir, timeoutMs, exited) {
  const file = join(userDataDir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (exited !== undefined && await Promise.race([exited, Promise.resolve("pending")]) !== "pending") {
      throw new Error(
        "the browser closed immediately after starting — it may have merged into an instance " +
          "of itself that is still running, or the profile was refused. Close other windows of the " +
          "same browser and try again.",
      )
    }
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, "utf8")
        const [port, path = "/devtools/browser"] = text.split("\n").map((line) => line.trim())
        if (port && /^\d+$/.test(port)) return { port: Number(port), path }
      } catch {
        // a half-written file: wait for the browser to finish
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

// connect retries the DevTools WebSocket a few times: the browser binds the
// port as (not before) it writes the endpoint file, so a refusal in the first
// second is a race, not a failure.
async function connect(cdpPort, path, attempts = 10) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await cdpConnection(cdpPort, path)
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(
    `the browser's DevTools endpoint at 127.0.0.1:${cdpPort}${path} refused the connection ` +
      `${attempts} times (${last?.message ?? "no reason"}). Close the browser window that just opened, then retry — ` +
      "or use the paste sign-in.",
  )
}

// cdpConnection wraps one browser-level WebSocket: `call` sends a method and
// resolves with its result, and `close` shuts the socket.
function cdpConnection(port, path) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    let nextId = 1
    const pending = new Map()
    socket.addEventListener("open", () => {
      resolve({
        socket,
        async call(method, params = {}) {
          const id = nextId++
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolveCall, rejectCall })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          try {
            socket.close()
          } catch {
            // already gone
          }
        },
      })
    })
    socket.addEventListener("message", (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.id && pending.has(frame.id)) {
        const { resolveCall, rejectCall } = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) rejectCall(new Error(`CDP ${frame.error.message ?? "error"}`))
        else resolveCall(frame.result)
      }
    })
    socket.addEventListener("error", () => reject(new Error("the browser's DevTools socket refused the connection")))
  })
}

// killTree stops the browser and its children — on Windows child.kill() only
// reaches the launcher, and the real browser processes stay up.
function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true })
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    // already gone
  }
}

// cdpSignin opens the machine's own browser on a fresh page of `url`, waits
// while the user signs in, and returns every cookie candidate it saw. The
// browser is closed when the turn ends, however it ends.
async function cdpSignin({ url, timeoutMs = 300_000, cookieName = "chatglm_refresh_token", signal, log } = {}) {
  const binary = browserBinary()
  if (!binary) {
    throw new Error(
      "No Edge, Chrome, Brave or Chromium was found on this machine — " +
        "install one, or use the paste sign-in.",
    )
  }
  const userDataDir = join(profileRoot(), "profile")
  mkdirSync(join(userDataDir, "Default"), { recursive: true })
  // The endpoint file of a killed attempt names a dead port: gone before the
  // browser starts, so the wait below reads this run's own endpoint.
  rmSync(join(userDataDir, "DevToolsActivePort"), { force: true })
  const child = spawn(binary, [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    url,
  ], { stdio: "ignore", windowsHide: false, detached: false })
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)))

  const seen = []
  const done = (async () => {
    if (typeof WebSocket === "undefined") {
      throw new Error("this runtime has no WebSocket — use the paste sign-in instead")
    }
    const endpoint = await devtoolsPort(userDataDir, 30_000, exited)
    if (!endpoint) throw new Error("the browser did not open its DevTools endpoint within 30 s")
    const cdp = await connect(endpoint.port, endpoint.path)
    let graceful = null
    try {
      await cdp.call("Storage.getCookies").catch(() => null)
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error("the sign-in was cancelled")
        if (Date.now() >= deadline) throw new Error(`the sign-in was not completed within ${Math.round(timeoutMs / 1000)} s — close the browser window or try again`)
        const result = await cdp.call("Storage.getCookies").catch(() => null)
        const cookies = Array.isArray(result?.cookies) ? result.cookies : []
        for (const cookie of cookies) {
          // The page mints an anonymous guest session for every visitor it
          // opens for — its refresh token rides the same cookie before anyone
          // signs in. Only a real account's token ends the wait.
          if (cookie.name === cookieName && cookie.value && !isGuestToken(cookie.value) && !seen.includes(cookie.value)) seen.push(cookie.value)
        }
        if (seen.length) {
          // A captured token ends the turn: the browser is asked to close
          // itself, which flushes the session's cookies to the profile — the
          // next sign-in then reads them silently, no window at all.
          graceful = cdp.call("Browser.close").catch(() => null)
          return seen
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } finally {
      cdp.close()
      if (graceful) await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 8000))])
    }
  })()

  try {
    return await done
  } finally {
    // The browser dies here on every ending — success, failure, cancel. The
    // cleanup must never mask the sign-in's own result: taskkill is
    // asynchronous, so the exit is awaited before the profile's leftover
    // locks are removed, and every removal is best-effort — a lock still held
    // by a dying process just stays for the next run's spawn to overwrite.
    killTree(child)
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(join(userDataDir, name), { force: true })
          break
        } catch {
          // still held by a dying process: give it a beat, then again
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    }
  }
}

// silentSignin reads the token the user's last controlled sign-in left in the
// plugin's own profile — its cookie store is ours to read, unlocked and
// decryptable, whenever the browser that owns it is closed.
function silentSignin(readProfile) {
  const dir = defaultProfileDir()
  if (!existsSync(dir)) return []
  try {
    // The reader copies the Cookies database through a scratch directory
    // before parsing it: hand one over, and take it back afterwards.
    const scratch = mkdtempSync(join(tmpdir(), "magpie-glm-silent-"))
    try {
      return readProfile(dir, scratch) ?? []
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } catch {
    return []
  }
}

export { profileRoot, defaultProfileDir, browserBinary, devtoolsPort, connect, cdpConnection, cdpSignin, silentSignin, killTree }
