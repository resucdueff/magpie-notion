import { randomUUID } from "node:crypto"

const ID = "notion"
const VIRTUAL_API = "https://notion.invalid/v1"
const encoder = new TextEncoder()

export class ProviderError extends Error {
  constructor(status, code, message, options = {}) {
    super(message)
    this.status = status
    this.code = code
    if (status === 401) this.signIn = "expired"
    if (options.retryAfter !== undefined) this.retryAfter = String(options.retryAfter)
  }
}

function publicError(error) {
  if (error instanceof ProviderError) return { message: error.message, type: "notion_error", code: error.code }
  return { message: "Notion AI request failed. No upstream diagnostic or session data was included.", type: "notion_error", code: "upstream_error" }
}

function errorResponse(error) {
  const headers = {}
  if (error?.signIn === "expired") headers["X-Magpie-Sign-In"] = "expired"
  if (error?.retryAfter !== undefined) headers["Retry-After"] = error.retryAfter
  return Response.json({ error: publicError(error) }, {
    status: error instanceof ProviderError ? error.status : 502,
    ...(Object.keys(headers).length ? { headers } : {}),
  })
}

function text(content) {
  if (typeof content === "string") return content
  if (content == null) return ""
  if (Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")) return content.map((part) => part.text).join("")
  throw new ProviderError(400, "unsupported_content", "This Notion adapter currently accepts text messages only.")
}

function callText(call) {
  const name = typeof call?.function?.name === "string" ? call.function.name : (typeof call?.name === "string" ? call.name : "tool")
  const args = call?.function?.arguments ?? call?.arguments
  const rendered = typeof args === "string" ? args : args == null ? "" : JSON.stringify(args)
  return rendered ? name + " " + rendered : name
}

// Client tools are not executed. Agents attach them to every request, so they
// are removed and any earlier tool result is kept as plain text.
function parseChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProviderError(400, "invalid_request", "Expected a JSON chat request.")
  if (typeof body.model !== "string" || !body.model.trim()) throw new ProviderError(400, "invalid_model", "A verified workspace model id is required.")
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new ProviderError(400, "invalid_stream", "stream must be a boolean.")
  if (body.n !== undefined && body.n !== 1) throw new ProviderError(400, "unsupported_parameter", "Only one completion is supported.")
  if (!Array.isArray(body.messages) || !body.messages.length) throw new ProviderError(400, "invalid_messages", "At least one message is required.")
  const messages = body.messages.map((message) => {
    if (!message || typeof message.role !== "string") throw new ProviderError(400, "unsupported_message", "Only text system, developer, user and assistant messages are supported.")
    if (message.role === "tool" || message.role === "function") {
      const name = typeof message.name === "string" && message.name.trim() ? message.name.trim() : "tool"
      const result = message.content != null && typeof message.content === "object" && !Array.isArray(message.content) ? JSON.stringify(message.content) : text(message.content)
      return { role: "user", content: result ? "[" + name + "]\n" + result : "[" + name + "]" }
    }
    if (!["system", "developer", "user", "assistant"].includes(message.role)) {
      throw new ProviderError(400, "unsupported_message", "Only text system, developer, user and assistant messages are supported.")
    }
    const calls = [...(Array.isArray(message.tool_calls) ? message.tool_calls : []), ...(message.function_call ? [message.function_call] : [])]
    const note = calls.map(callText).filter(Boolean).join("\n")
    const content = text(message.content)
    return { role: message.role, content: content && note ? content + "\n" + note : content || note }
  })
  const { tools, functions, tool_choice, function_call, ...rest } = body
  return { ...rest, messages }
}


// These events are an adapter contract, not a claim about Notion's wire format.
// A decoder must yield text deltas and one explicit done; EOF alone is a failure.
async function* completionChunks(events, model, signal) {
  const id = "chatcmpl-" + randomUUID()
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish_reason = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })
  yield chunk({ role: "assistant", content: "" })
  try {
    for await (const event of events) {
      signal.throwIfAborted()
      if (event?.type === "text" && typeof event.text === "string") {
        if (event.text) yield chunk({ content: event.text })
      } else if (event?.type === "done" && ["stop", "length", "content_filter"].includes(event.finishReason ?? "stop")) {
        yield chunk({}, event.finishReason ?? "stop")
        return
      } else {
        throw new ProviderError(502, "invalid_upstream_event", "Notion AI returned an unsupported response event.")
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw error
  }
  throw new ProviderError(502, "incomplete_upstream", "Notion AI ended the response without a verified completion event.")
}

function streamResponse(chunks, cancel) {
  const iterator = chunks[Symbol.asyncIterator]()
  const frame = (value) => encoder.encode("data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n\n")
  let ended = false
  return new Response(new ReadableStream({
    async pull(controller) {
      if (ended) return
      try {
        const next = await iterator.next()
        if (ended) return
        if (next.done) {
          ended = true
          controller.enqueue(frame("[DONE]"))
          controller.close()
          cancel()
        } else controller.enqueue(frame(next.value))
      } catch (error) {
        if (ended) return
        ended = true
        controller.enqueue(frame({ error: publicError(error) }))
        controller.close()
        cancel()
      }
    },
    async cancel(reason) {
      ended = true
      cancel(reason)
      await iterator.return?.()
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } })
}

// bufferedResponse answers a non-streaming request from the same event
// contract the streaming path uses: text deltas, then one explicit done whose
// text is the committed answer. The done text is authoritative, because a
// provisional message that was streamed can be replaced by a shorter committed
// one, and nothing must be invented when the stream ends without it.
async function bufferedResponse(events, model, signal) {
  const id = "chatcmpl-" + randomUUID()
  const created = Math.floor(Date.now() / 1000)
  let content = ""
  let finishReason
  for await (const event of events) {
    signal.throwIfAborted()
    if (event?.type === "text" && typeof event.text === "string") content += event.text
    else if (event?.type === "done" && ["stop", "length", "content_filter"].includes(event.finishReason ?? "stop")) {
      if (typeof event.text === "string") content = event.text
      finishReason = event.finishReason ?? "stop"
      break
    } else {
      throw new ProviderError(502, "invalid_upstream_event", "Notion AI returned an unsupported response event.")
    }
  }
  if (finishReason === undefined) throw new ProviderError(502, "incomplete_upstream", "Notion AI ended the response without a verified completion event.")
  return Response.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }] })
}

function scopedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(new ProviderError(499, "request_cancelled", "The client cancelled the Notion AI request."))
  const timer = setTimeout(() => controller.abort(new ProviderError(504, "request_timeout", "The Notion AI request exceeded its total time limit.")), timeoutMs)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  return { signal: controller.signal, close: (reason) => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.abort(reason)
  } }
}

export function createPlugin(protocol, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error("Notion timeoutMs must be between 1000 and 3600000 milliseconds.")
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: "Notion AI",
        npm: "@ai-sdk/openai-compatible",
        api: VIRTUAL_API,
        models: { "omniberry-sundae": { name: "Notion AI（登录后刷新模型列表）", tool_call: false, attachment: false, modalities: { input: ["text"], output: ["text"] } } },
      }
    },
    auth: {
      provider: ID,
      // 0 means Magpie does not limit how many requests one account has in flight.
      maxConcurrency: 0,
      methods: [
        { type: "api", label: "粘贴 token_v2", placeholder: "只粘贴 token_v2" },
      ],
      async loader(getAuth) {
        return {
          baseURL: VIRTUAL_API,
          apiKey: "notion-local-adapter",
          async fetch(input, init = {}) {
            let scope
            try {
              const request = new Request(input, init)
              const url = new URL(request.url)
              if (url.origin !== new URL(VIRTUAL_API).origin || url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
                throw new ProviderError(400, "unsupported_request", "Only chat completions are supported by this adapter.")
              }
              let body
              try { body = await request.json() } catch { throw new ProviderError(400, "invalid_json", "Expected a JSON chat request.") }
              const chat = parseChat(body)
              scope = scopedSignal(request.signal, timeoutMs)
              scope.signal.throwIfAborted()
              const auth = await getAuth()
              const events = await protocol.open({ auth, chat, signal: scope.signal })
              if (chat.stream) return streamResponse(completionChunks(events, chat.model, scope.signal), scope.close)
              try { return await bufferedResponse(events, chat.model, scope.signal) } finally { scope.close() }
            } catch (error) {
              if (scope?.signal.aborted && scope.signal.reason instanceof ProviderError) error = scope.signal.reason
              scope?.close()
              return errorResponse(error)
            }
          },
        }
      },
      // Magpie's usage card: the workspace's rolling and billing allowance
      // plus the premium credit balance. A missing auth or an unreadable
      // response is an error to show, never an empty account.
      async usage(getAuth) {
        try {
          return await protocol.usage({ auth: await getAuth() })
        } catch {
          return { error: "无法读取 Notion AI 额度。", windows: [] }
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth }) {
        return await protocol.models({ provider, auth })
      },
    },
  }
}

export const _internal = { parseChat, completionChunks, streamResponse, bufferedResponse, publicError, scopedSignal, errorResponse }
