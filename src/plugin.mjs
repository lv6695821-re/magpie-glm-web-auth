// The plugin
//
// `server` is the OpenCode/magpie plugin function: it declares the provider,
// signs in (from the browser profile or a pasted token), and hands the AI SDK
// a fetch that speaks chatglm.cn and answers in OpenAI chat completions.

import {
  PROVIDER,
  NAME,
  NPM,
  DEFAULT_ORIGIN,
  MODELS,
  CHAT_PATHS,
  configModels,
  accountLabel,
} from "./config.mjs"
import { whoAmI, findBrowserToken, findLiveBrowserToken, chromiumCookieCandidatesHex } from "./browser-token.mjs"
import { cdpSignin, silentSignin } from "./browser-login.mjs"
import { deleteConversation, isTitleRequest } from "./api.mjs"
import { TokenKeeper } from "./token.mjs"
import { encoder, chunk, finishReason, messagesToPrompt, messageSignature } from "./openai.mjs"
import { runTurn } from "./turn.mjs"

// success shapes the token a sign-in found into what the host saves.
function success(token, who, source) {
  return {
    type: "success",
    access: token,
    // chatglm.cn's refresh token is long-lived (the page's own cookie lasts
    // months); it is replaced by a new sign-in or refused, never refreshed
    // by us.
    refresh: "",
    expires: Date.now() + 365 * 24 * 3600 * 1000,
    accountId: who?.name || accountLabel(token),
    name: who?.name || undefined,
    metadata: { source },
  }
}

export const server = async (_input, _options) => {
  const origin = _options?.origin ?? DEFAULT_ORIGIN
  const GLM = {
    name: NAME,
    npm: NPM,
    api: origin,
    models: configModels(),
  }
  // One chatglm.cn conversation per conversation the agent is having: agent
  // session → the conversation it opened, the message signature of the last
  // turn it sent, and when it was last used. Sessions idle past the TTL are
  // dropped, so a day-old thread starts a fresh conversation rather than
  // holding the account to one that may be gone.
  const sessions = new Map()
  const SESSION_TTL = 6 * 3600 * 1000
  // The access tokens, one per signed-in account.
  const tokens = new TokenKeeper()
  return {
    config(config) {
      config.provider ??= {}
      config.provider[PROVIDER] ??= GLM
    },
    // magpie's own hook: the agent's session id rides in here, which is what
    // keeps one agent conversation on one chatglm.cn conversation. OpenCode
    // ignores it.
    async "chat.headers"(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.model?.providerID !== `${PROVIDER}-plugin`) return
      if (!input.sessionID) return
      output.headers["x-magpie-session"] = input.sessionID
    },
    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: "Sign in with the browser (chatglm.cn)",
          // The browser sign-in opens the machine's own Edge or Chrome on a
          // profile of the plugin's own — the way the DSH plugins do it — and
          // watches the session for the page's chatglm_refresh_token cookie
          // while the user signs in. A profile from an earlier sign-in is
          // read silently first, so a repeat sign-in opens no window. The
          // user's running browser is never touched: its cookie store is
          // locked and, on recent Chrome/Edge, app-bound encrypted. The host
          // wants the {url, instructions, method, callback} envelope an oauth
          // method returns, so the work happens in callback and "auto" says
          // nothing needs typing.
          async authorize() {
            return {
              url: `${origin}/main/alltoolsdetail`,
              instructions:
                "Opening chatglm.cn in a browser window of its own — sign in there " +
                "(QR code or password) and this completes by itself. A sign-in from " +
                "before is reused without opening anything.",
              method: "auto",
              async callback() {
                // The quiet path: the profile a previous sign-in left behind.
                const silent = silentSignin(chromiumCookieCandidatesHex)
                for (const token of silent) {
                  const who = await whoAmI(origin, token).catch(() => null)
                  if (who) {
                    return success(token, who, "plugin profile (reuse)")
                  }
                }
                // The window path: launch and watch.
                try {
                  const candidates = await cdpSignin({ url: `${origin}/main/alltoolsdetail` })
                  for (const token of candidates) {
                    const who = await whoAmI(origin, token).catch(() => null)
                    if (who) {
                      return success(token, who, "browser window sign-in")
                    }
                  }
                  return {
                    type: "failed",
                    error:
                      "The sign-in window closed before a chatglm.cn session was seen. " +
                      "Make sure you completed the login (QR code or password) in that window, then try again — " +
                      "or use the paste sign-in.",
                  }
                } catch (error) {
                  return {
                    type: "failed",
                    error: `${error?.message ?? error} — or use the paste sign-in ` +
                      "(F12 → Application → Cookies → chatglm_refresh_token on a signed-in chatglm.cn tab).",
                  }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "Paste a chatglm.cn token",
          placeholder: "chatglm_refresh_token",
          // The host hands an api method's answered prompts, not the key: the
          // key is given to the sign-in separately and saved from there. So
          // there is nothing to check here unless a caller passed the token in
          // as an input (OpenCode's TUI does); otherwise the loader checks it
          // on the first request and says so.
          async authorize(inputs) {
            const token = String(inputs?.token ?? inputs?.key ?? "").trim()
            if (!token) return { type: "success", metadata: { source: "pasted" } }
            const who = await whoAmI(origin, token).catch(() => null)
            if (!who) {
              return {
                type: "failed",
                error:
                  "chatglm.cn refused that token — copy chatglm_refresh_token's value from a signed-in " +
                  "chatglm.cn tab (F12 → Application → Local Storage → chatglm_refresh_token, or Cookies)",
              }
            }
            return {
              type: "success",
              key: token,
              accountId: who.name || accountLabel(token),
              metadata: { source: "pasted" },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const refreshToken = auth?.type === "oauth" ? auth.access : auth?.key
        if (!refreshToken) return {}
        // A pasted token is checked once here, when the host knows the account
        // but not whether the string is a live session: a typo should say so
        // rather than look like a model that fails every turn.
        if (auth?.type === "api") {
          const who = await whoAmI(origin, refreshToken).catch(() => null)
          if (!who) {
            const error = new Error(
              "chatglm.cn refused this token — sign in again with a token copied from a " +
                "signed-in chatglm.cn tab (F12 → Application → Local Storage → chatglm_refresh_token)",
            )
            error.signIn = "expired"
            throw error
          }
        }
        return {
          baseURL: origin,
          apiKey: refreshToken,
          // The host calls this as `fetch(url, init)` with a string URL (as
          // the AI SDK does); OpenCode may hand a Request instead. Accept both.
          async fetch(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            const url = new URL(request.url)
            if (!CHAT_PATHS[url.pathname] || request.method !== "POST") {
              throw new Error(`GLM: unsupported request ${request.method} ${url.pathname}`)
            }
            const body = await request.json()
            const model = MODELS.find((m) => m.id === body.model)
            if (!model) throw new Error(`GLM: unknown model ${JSON.stringify(body.model)}`)
            const fresh = await getAuth()
            const live = fresh?.type === "oauth" ? fresh.access : fresh?.key
            if (!live) throw new Error("GLM: not signed in")
            const streaming = body.stream !== false
            const thinking = model.thinking === "on" || body.reasoning_effort === "high" || body.reasoning_effort === "medium"
            // Web search rides the completion as the page's own toggle does:
            // on for every turn unless the model (the -search variant) or the
            // request turns it off for itself.
            const search = model.search === "on" ? true : model.search === "page" ? body.search_enabled !== false : false
            const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`
            const created = Math.floor(Date.now() / 1000)

            // One chatglm.cn conversation per conversation the agent is
            // having: the web app's conversation remembers its turns, so turn
            // N+1 sends only what is new and rides the same conversation_id,
            // the way the page does when you keep typing in one chat. The
            // agent's session id comes through chat.headers; an agent that
            // sends none gets one conversation per request.
            const sessionKey = request.headers.get("x-magpie-session") || `solo-${id}`
            const messages = body.messages ?? []
            // A title request is magpie's own housekeeping, not the
            // conversation: it is answered from a conversation of its own that
            // is deleted when the title is in, and the conversation's mapping
            // is left exactly as it was.
            const titleRequest = isTitleRequest(messages)
            // Tools ride the prompt as a protocol: the stream has no tools
            // field, so the prompt teaches the model the DSML call shape and
            // the reply's blocks are parsed back into tool_calls.
            // tool_choice "none" says the client wants none of it, and a title
            // request is housekeeping with no tools of its own.
            const toolChoice = body.tool_choice ?? "auto"
            const wantsTools = toolChoice !== "none" && Array.isArray(body.tools) && body.tools.length > 0
            const tools = wantsTools && !titleRequest ? body.tools : null
            const known = sessions.get(sessionKey)
            let from = 0
            let conversationId = null
            if (!titleRequest && known?.conversationId && Date.now() - (known.at ?? 0) <= SESSION_TTL) {
              // Where the conversation we already sent carries on: the anchor
              // is the last message of the previous request, found again in
              // this one. A history that grew — the usual tool loop, the
              // model's call and the client's result — continues the same
              // chatglm.cn conversation with only the new turns. A history the
              // agent rewrote (compaction, pruned results) that no longer
              // holds the anchor, or one identical to what was already
              // answered, starts a fresh conversation with the whole labelled
              // story.
              let found = -1
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messageSignature(messages[i]) === known.anchor) {
                  found = i
                  break
                }
              }
              if (found !== -1 && found + 1 < messages.length) {
                conversationId = known.conversationId
                from = found + 1
              }
            }
            let prompt = messagesToPrompt(messages, from, { tools })
            if (!prompt && !titleRequest && messages.length) {
              // a slice that renders empty is all echoes of replies the
              // conversation already holds: start over with the whole story
              conversationId = null
              from = 0
              prompt = messagesToPrompt(messages, 0, { tools })
            }
            if (!titleRequest && conversationId === null) sessions.delete(sessionKey)

            let last = null
            const stream = new ReadableStream({
              async start(controller) {
                let sent = 0
                let reasoningSent = 0
                let roleSent = false
                let failure = null
                let usedConversation = conversationId
                // A reply chatglm.cn turns away (its conversation was deleted,
                // it hit its busy limit) starts a new conversation with the
                // whole history once, rather than failing the turn.
                for (const attempt of [0, 1]) {
                  failure = null
                  // The access token: kept warm ahead of expiry, one refresh
                  // in flight at a time.
                  let accessToken
                  try {
                    accessToken = await tokens.access(origin, live, request.signal)
                  } catch (error) {
                    failure = error
                    break
                  }
                  const promptTurn = attempt === 0 ? prompt : messagesToPrompt(messages, 0, { tools })
                  const turn = runTurn({
                    origin,
                    accessToken,
                    prompt: promptTurn,
                    thinking,
                    search,
                    tools: tools !== null,
                    signal: request.signal,
                    conversationId: attempt === 0 ? usedConversation : null,
                  })
                  try {
                    // Driven by next() rather than for-await, so the turn's
                    // return — the conversation it used — is read when the
                    // stream is done.
                    for (;;) {
                      const step = await turn.next()
                      if (step.done) {
                        const used = step.value
                        usedConversation = used?.conversationId ?? null
                        if (used?.conversationId && !titleRequest) {
                          sessions.set(sessionKey, {
                            conversationId: used.conversationId,
                            anchor: messageSignature(messages[messages.length - 1]),
                            at: Date.now(),
                          })
                        }
                        break
                      }
                      const state = step.value
                      last = state
                      if (!roleSent) {
                        roleSent = true
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { role: "assistant", content: "" })))
                      }
                      if (state.reasoning.length > reasoningSent) {
                        const delta = state.reasoning.slice(reasoningSent)
                        reasoningSent = state.reasoning.length
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { reasoning_content: delta })))
                      }
                      if (state.text.length > sent) {
                        const delta = state.text.slice(sent)
                        sent = state.text.length
                        controller.enqueue(encoder.encode(chunk(id, created, model.id, { content: delta })))
                      }
                    }
                    break
                  } catch (error) {
                    failure = error
                    // A conversation the account no longer serves, or a token
                    // the page rotated: start over with a fresh one and the
                    // whole history, once. A dead token is the sign-in's
                    // business, not a retry's.
                    if (attempt === 0 && !error?.signIn) {
                      usedConversation = null
                      sent = 0
                      reasoningSent = 0
                      roleSent = false
                      last = null
                      continue
                    }
                    break
                  }
                }
                if (failure) {
                  // A title conversation that failed still goes: it was only
                  // opened to be thrown away.
                  if (titleRequest && usedConversation) {
                    const accessToken = await tokens.access(origin, live).catch(() => null)
                    if (accessToken) await deleteConversation(origin, accessToken, null, usedConversation)
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure.message ?? String(failure), type: "upstream_error" } })}\n\n`))
                  controller.close()
                  return
                }
                // A title conversation is deleted as soon as its title is in:
                // it is not the conversation's chat and the account should not
                // keep it. Awaited, so the reply arriving means the chat is
                // already gone.
                if (titleRequest && usedConversation) {
                  const accessToken = await tokens.access(origin, live).catch(() => null)
                  if (accessToken) await deleteConversation(origin, accessToken, null, usedConversation)
                }
                // Tool calls the model made come as their own deltas, complete
                // per call, and end the turn with finish_reason "tool_calls".
                const calls = last?.toolCalls ?? []
                for (const [index, call] of calls.entries()) {
                  controller.enqueue(encoder.encode(chunk(id, created, model.id, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] })))
                }
                controller.enqueue(encoder.encode(chunk(id, created, model.id, {}, calls.length ? "tool_calls" : finishReason(last?.status))))
                controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                controller.close()
              },
            })
            const headersOut = new Headers()
            headersOut.set("content-type", "text/event-stream; charset=utf-8")
            headersOut.set("cache-control", "no-cache")
            if (!streaming) {
              // A caller that asked for one answer gets the stream folded up.
              const collected = await new Response(stream).text()
              let text = ""
              let reasoning = ""
              let finish = "stop"
              const calls = []
              for (const line of collected.split("\n")) {
                if (!line.startsWith("data: ")) continue
                const payload = line.slice(6)
                if (payload === "[DONE]") continue
                let frame
                try {
                  frame = JSON.parse(payload)
                } catch {
                  continue
                }
                if (frame.error) throw new Error(frame.error.message)
                const choice = frame.choices?.[0]
                if (choice) {
                  text += choice.delta?.content ?? ""
                  reasoning += choice.delta?.reasoning_content ?? ""
                  for (const call of choice.delta?.tool_calls ?? []) calls.push(call)
                  if (choice.finish_reason) finish = choice.finish_reason
                }
              }
              const message = { role: "assistant", content: text }
              if (reasoning) message.reasoning_content = reasoning
              if (calls.length) message.tool_calls = calls
              return new Response(
                JSON.stringify({
                  id,
                  object: "chat.completion",
                  created,
                  model: model.id,
                  choices: [{ index: 0, message, finish_reason: finish }],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            }
            return new Response(stream, { status: 200, headers: headersOut })
          },
        }
      },
    },
    async usage() {
      // The web app exposes no allowance to read; the account's own page does.
      return { plan: "GLM 智谱清言 (web)", windows: [] }
    },
    provider: {
      id: PROVIDER,
      async models(provider) {
        return provider.models
      },
    },
  }
}
