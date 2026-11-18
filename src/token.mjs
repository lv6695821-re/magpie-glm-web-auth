// Token lifecycle
//
// chatglm.cn hands the page a short-lived access_token for a long-lived
// refresh_token; every signed request carries the access_token. This module
// keeps one access_token per refresh_token, refreshed ahead of expiry, and
// handed back on each request — the page's own session flow.

import { headers, signed, json } from "./api.mjs"
import { REFRESH_PATH } from "./config.mjs"

const ACCESS_TOKEN_TTL_MS = 3600 * 1000
// Refresh ahead of expiry, so a token that lapses mid-turn does not.
const REFRESH_MARGIN_MS = 60 * 1000

class TokenKeeper {
  constructor() {
    this.map = new Map() // refreshToken → {accessToken, refreshToken, at}
    this.queue = new Map() // refreshToken → promise (one refresh in flight)
  }

  // access returns a live access_token (the string the request headers carry)
  // for the refresh_token, refreshing when there is none or it has lapsed. One
  // refresh runs per token at a time; concurrent turns wait on the same
  // promise rather than racing.
  async access(origin, refreshToken, signal) {
    const known = this.map.get(refreshToken)
    if (known && Date.now() - known.at < ACCESS_TOKEN_TTL_MS - REFRESH_MARGIN_MS) return known.accessToken
    const inFlight = this.queue.get(refreshToken)
    if (inFlight) return inFlight
    const task = this.refresh(origin, refreshToken, signal)
      .catch((error) => {
        this.queue.delete(refreshToken)
        throw error
      })
      .then((fresh) => {
        this.queue.delete(refreshToken)
        return fresh.accessToken
      })
    this.queue.set(refreshToken, task)
    return task
  }

  async refresh(origin, refreshToken, signal) {
    const response = await fetch(`${origin}${REFRESH_PATH}`, {
      method: "POST",
      headers: headers(origin, { authorization: `Bearer ${refreshToken}`, ...signed() }),
      body: JSON.stringify({}),
      signal,
    })
    const result = await json(response, "token refresh")
    const accessToken = result?.access_token
    const next = result?.refresh_token ?? refreshToken
    if (!accessToken) throw new Error("GLM token refresh: no access_token returned")
    this.map.set(refreshToken, { accessToken, refreshToken: next, at: Date.now() })
    // chatglm.cn rotates the refresh_token on each use: the new one replaces
    // the old, and the caller is told so it can be persisted by the host.
    return { accessToken, refreshToken: next, rotated: next !== refreshToken }
  }

  // forget drops a token whose account has been refused.
  forget(refreshToken) {
    this.map.delete(refreshToken)
  }
}

export { TokenKeeper, ACCESS_TOKEN_TTL_MS, REFRESH_MARGIN_MS }
