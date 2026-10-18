import { ProviderError } from "./core.mjs"

function invalid() {
  return new ProviderError(502, "invalid_transcript", "Notion AI returned an unsupported transcript update.")
}

function messageText(entity) {
  if (!Array.isArray(entity.content)) throw invalid()
  return entity.content.filter((part) => part?.type === "text").map((part) => {
    if (typeof part.text !== "string") throw invalid()
    return part.text
  }).join("")
}

function append(entity, operation) {
  if (operation.op !== "append" || typeof operation.value !== "string") throw invalid()
  const match = /^\/content\/(\d+)\/text$/.exec(operation.path)
  if (!match) throw invalid()
  const part = entity.content?.[Number(match[1])]
  if (part?.type !== "text" || typeof part.text !== "string") throw invalid()
  part.text += operation.value
  return operation.value
}

// One frame of its own may not be larger than this. The limit is per frame and
// not per network read: a reader may hand over a whole batch of small frames at
// once, which used to be refused as one oversized frame.
const MAX_FRAME = 4 * 1024 * 1024

function tooLarge() {
  return new ProviderError(502, "transcript_frame_too_large", "Notion AI returned an oversized transcript frame.")
}

function frameLine(raw) {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
  if (line.length > MAX_FRAME) throw tooLarge()
  return line.trim()
}

export function sessionError(session) {
  const allowance = session?.last_turn_allowance
  if (allowance?.notion_exhausted === true) throw new ProviderError(402, "credits_exhausted", "The Notion workspace has exhausted its Notion AI credits.")
  if (allowance?.chatgpt_exhausted === true) throw new ProviderError(402, "connected_plan_exhausted", "The connected ChatGPT plan's allowance is exhausted.")
  if (session?.pending_input) throw new ProviderError(409, "notion_action_required", "The Notion agent requires approval or input in the Notion client.")
}

export async function* readNDJSON(body, signal) {
  if (!body) throw invalid()
  const reader = body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      signal?.throwIfAborted()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      let newline
      let start = 0
      while ((newline = pending.indexOf("\n", start)) >= 0) {
        const line = frameLine(pending.slice(start, newline))
        start = newline + 1
        if (!line) continue
        try { yield JSON.parse(line) } catch (error) {
          if (error instanceof SyntaxError) throw invalid()
          throw error
        }
      }
      pending = start ? pending.slice(start) : pending
      // A frame that never ends must not grow without bound either.
      // A trailing CR may be the first half of a CRLF delimiter.
      if (pending.length > MAX_FRAME + (pending.endsWith("\r") ? 1 : 0)) throw tooLarge()
    }
    pending += decoder.decode()
    const line = frameLine(pending)
    if (line) {
      let value
      try { value = JSON.parse(line) } catch { throw invalid() }
      yield value
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Real Notion transcript deltas replace provisional messages with committed
// entities. Apply the whole patch batch before comparing the visible text.
export async function* transcriptEvents(frames, signal, { afterSequence = 0 } = {}) {
  const entities = new Map()
  let emitted = ""
  // The visible text is kept in step with the frames instead of being rebuilt
  // from every entity each time: an answer arrives as thousands of appended
  // fragments, and re-joining the whole message for each one of them is
  // quadratic work for a linear change. A put, a remove, or an append to a
  // message that is not the last one falls back to a rebuild, and `aligned`
  // records whether what has been sent is still exactly the visible text.
  let visible = ""
  let tail
  let appended = null
  let rebuild = true
  let aligned = true
  const render = () => {
    const messages = [...entities.values()].filter((entity) => entity.kind === "assistant_message").sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    visible = messages.map(messageText).join("")
    tail = messages.at(-1)
  }
  for await (const frame of frames) {
    signal?.throwIfAborted()
    if (!["agent_service_transcript_delta", "agent_service_transcript_page"].includes(frame?.type)) continue
    if (!Array.isArray(frame.patches)) throw invalid()
    const checkSession = (session) => {
      if (afterSequence === 0 || session?.sequence > afterSequence || session?.last_turn_allowance?.sequence > afterSequence) sessionError(session)
    }
    checkSession(frame.session)
    let completed
    appended = null
    for (const patch of frame.patches) {
      if (patch.op === "put") {
        const entity = patch.entity
        if (!entity || typeof entity.id !== "string") throw invalid()
        if (entity.kind === "turn_completed" && (!Number.isSafeInteger(entity.sequence) || entity.sequence <= 0 || (entity.source !== undefined && entity.source !== "committed"))) throw invalid()
        if (entity.sequence <= afterSequence) continue
        entities.set(entity.id, structuredClone(entity))
        rebuild = true
        if (entity.kind === "error") throw new ProviderError(502, "notion_agent_error", "The Notion agent reported an error. Open its thread in Notion for details.")
        if (entity.kind === "client_update_required") throw new ProviderError(502, "notion_client_update_required", "Notion requires a newer client protocol.")
        if (entity.kind === "status" && entity.status === "per_user_connection_required") throw new ProviderError(409, "connection_required", "Complete the requested account connection in the Notion client.")
        if (entity.kind === "turn_completed") completed = entity
      } else if (patch.op === "remove") {
        if (entities.delete(patch.id)) rebuild = true
      } else if (patch.op === "patch") {
        const entity = entities.get(patch.id)
        if (entity?.kind !== "assistant_message") continue
        if (!Array.isArray(patch.ops)) throw invalid()
        let added = ""
        for (const operation of patch.ops) added += append(entity, operation)
        // Multipart edits can insert before text already sent to the client.
        if (entity === tail && entity.content.length === 1) appended = (appended ?? "") + added
        else rebuild = true
      } else if (["session_status", "session"].includes(patch.op)) checkSession(patch.session)
      else if (patch.op !== "committed") throw invalid()
    }
    if (rebuild) {
      render()
      appended = null
      rebuild = false
    }
    if (appended !== null && aligned) {
      if (appended) {
        emitted += appended
        visible = emitted
        yield { type: "text", text: appended }
      }
    } else if (visible.startsWith(emitted)) {
      const delta = visible.slice(emitted.length)
      emitted = visible
      aligned = true
      if (delta) yield { type: "text", text: delta }
    } else if (!emitted.startsWith(visible)) {
      throw new ProviderError(502, "transcript_rewritten", "Notion AI rewrote text already sent to the client.")
    } else {
      // A committed message can be shorter than provisional text that was
      // already sent. That text cannot be taken back, so it stands, and the next
      // append continues from the committed one.
      aligned = false
    }
    if (completed) {
      if (completed.stop_reason === "requires_action") throw new ProviderError(409, "notion_action_required", "The Notion agent requires approval or input in the Notion client.")
      if (["runtime_error", "retries_exhausted"].includes(completed.stop_reason)) throw new ProviderError(502, "notion_agent_error", "The Notion agent could not complete this turn.")
      if (completed.stop_reason !== "end_turn") {
        throw new ProviderError(502, "unsupported_stop_reason", "Notion AI ended with an unverified stop reason.")
      }
      if (!visible) throw new ProviderError(502, "empty_answer", "Notion AI completed the turn without any text to send.")
      // Streaming text cannot be taken back. Report exactly what was yielded,
      // so buffered clients, streaming clients and the next-turn cache all see
      // the same assistant message.
      yield { type: "done", finishReason: "stop", sequence: completed.sequence, text: emitted }
      return
    }
  }
  throw new ProviderError(502, "incomplete_upstream", "Notion AI ended the transcript before turn completion.")
}

export const _internal = { append, messageText, sessionError }
