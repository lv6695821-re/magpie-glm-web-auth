// One turn against the page's completion endpoint: the signed request and the
// SSE snapshot stream.

import { headers, signed, json } from "./api.mjs"
import { STREAM_PATH, DEFAULT_ASSISTANT_ID } from "./config.mjs"
import { PartReader, iterSse } from "./stream.mjs"

// A turn chatglm.cn turns away with its "busy" business code (only one reply
// generating per account) is retried after a wait, as the page's own client
// waits for its queue.
const BUSY_CODE = 10061
const BUSY_RETRIES = 3
const BUSY_WAIT_MS = 4000

// runTurn drives one turn: the prompt, the model's thinking and search flags
// and the conversation to continue. It yields the reader after each snapshot
// and returns the conversation the turn ran in (with the account's own
// conversation_id), what the next turn in this agent conversation chains to.
async function* runTurn({ origin, accessToken, prompt, thinking, search, tools = false, signal, conversationId = null, assistantId = DEFAULT_ASSISTANT_ID }) {
  const reader = new PartReader({ tools })
  let busy = 0
  for (;;) {
    const response = await fetch(`${origin}${STREAM_PATH}`, {
      method: "POST",
      headers: headers(origin, { authorization: `Bearer ${accessToken}`, ...signed() }),
      body: JSON.stringify({
        assistant_id: assistantId,
        conversation_id: conversationId ?? "",
        project_id: "",
        chat_type: "user_chat",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        ],
        meta_data: {
          channel: "",
          // The page's model switch: "zero" is the thinking model, "" the
          // plain one, "deep_research" the deep-thought one.
          chat_mode: thinking ? "zero" : "",
          draft_id: "",
          if_plus_model: true,
          input_question_type: "xxxx",
          is_networking: search,
          is_test: false,
          platform: "pc",
          quote_log_id: "",
          cogview: { rm_label_watermark: false },
        },
      }),
      signal,
    })
    if (response.status === 401 || response.status === 403) {
      const error = new Error("GLM: the sign-in was refused — sign in to chatglm.cn again")
      error.signIn = "expired"
      throw error
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      // A refused turn answers JSON: the envelope says why. The busy code
      // waits and retries; anything else is the turn's failure.
      const failure = await json(response, "completion", { allow: [BUSY_CODE] }).catch((error) => error)
      if (failure instanceof Error && Number(failure.code) === BUSY_CODE && busy < BUSY_RETRIES) {
        busy += 1
        await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
        continue
      }
      if (failure instanceof Error) throw failure
      // An empty envelope the page sometimes answers for a finished
      // conversation: a fresh one carries the whole history again.
      throw new Error(`GLM completion: expected a stream, got ${contentType || "no content type"}`)
    }
    for await (const frame of iterSse(response.body)) {
      reader.apply(frame)
      yield reader
      if (reader.status === "finish" || reader.status === "intervene") {
        reader.finished = true
        break
      }
    }
    // The stream is done: what a split tag left held is put out before the
    // turn's state is read.
    reader.flushHold()
    // A stream that ended without a status: the page's own client treats the
    // close as the turn's end, so the turn stands as arrived.
    return { conversationId: reader.conversationId, status: reader.status }
  }
}

export { runTurn, BUSY_CODE, BUSY_RETRIES, BUSY_WAIT_MS }
