import { randomUUID } from "node:crypto"
import * as localSession from "./session.mjs"

const ID = "notion"
const VIRTUAL_API = "https://notion.invalid/v1"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()

export class ProviderError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
    if (status === 401) this.signIn = "expired"
  }
}

function publicError(error) {
  if (error instanceof ProviderError) return { message: error.message, type: "notion_error", code: error.code }
  return { message: "Notion AI request failed. No upstream diagnostic or session data was included.", type: "notion_error", code: "upstream_error" }
}

function errorResponse(error) {
  return Response.json({ error: publicError(error) }, {
    status: error instanceof ProviderError ? error.status : 502,
    ...(error?.signIn === "expired" ? { headers: { "X-Magpie-Sign-In": "expired" } } : {}),
  })
}

function text(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content) && content.every((part) => part?.type === "text" && typeof part.text === "string")) return content.map((part) => part.text).join("")
  throw new ProviderError(400, "unsupported_content", "This Notion adapter currently accepts text messages only.")
}

function parseChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProviderError(400, "invalid_request", "Expected a JSON chat request.")
  if (typeof body.model !== "string" || !body.model.trim()) throw new ProviderError(400, "invalid_model", "A verified workspace model id is required.")
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new ProviderError(400, "invalid_stream", "stream must be a boolean.")
  if (body.n !== undefined && body.n !== 1) throw new ProviderError(400, "unsupported_parameter", "Only one completion is supported.")
  if ((body.tools?.length ?? 0) || (body.functions?.length ?? 0) || (body.tool_choice !== undefined && body.tool_choice !== "none") || (body.function_call !== undefined && body.function_call !== "none")) {
    throw new ProviderError(400, "unsupported_tools", "Notion tool calling has not been verified and is not supported by this adapter.")
  }
  if (!Array.isArray(body.messages) || !body.messages.length) throw new ProviderError(400, "invalid_messages", "At least one message is required.")
  const messages = body.messages.map((message) => {
    if (!message || !["system", "developer", "user", "assistant"].includes(message.role) || message.tool_calls?.length || message.function_call) {
      throw new ProviderError(400, "unsupported_message", "Only text system, developer, user and assistant messages are supported.")
    }
    return { role: message.role, content: text(message.content) }
  })
  return { ...body, messages }
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

async function bufferedResponse(chunks) {
  let result
  let content = ""
  let finishReason
  for await (const chunk of chunks) {
    result ??= chunk
    content += chunk.choices[0].delta.content ?? ""
    finishReason = chunk.choices[0].finish_reason ?? finishReason
  }
  return Response.json({ id: result.id, object: "chat.completion", created: result.created, model: result.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }] })
}

function scopedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort(new ProviderError(499, "request_cancelled", "The client cancelled the Notion AI request."))
  const timer = setTimeout(() => controller.abort(new ProviderError(504, "request_timeout", "The Notion AI request exceeded its total time limit.")), timeoutMs)
  timer.unref?.()
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  return { signal: controller.signal, close: (reason) => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.abort(reason)
  } }
}

// browserSignIn takes the Notion session of the browser this machine is already
// signed in to, the way the other magpie plugins take the sign-in of the app
// they belong to. Nothing is asked and nothing is shown: the method resolves on
// its own, and the workspace is discovered from the session later, so nobody
// has to paste a UUID.
async function browserSignIn(session) {
  return {
    url: "",
    instructions: "Reads the Notion session from the Chrome, Edge, Brave, Chromium or Firefox profile on this machine.",
    method: "auto",
    callback: async () => {
      try {
        const found = await session.findSession()
        return {
          type: "success",
          key: found.cookie,
          metadata: { browser: found.browser, profile: found.profile, ...(found.via ? { via: found.via } : {}), ...(found.activeUserId ? { activeUserId: found.activeUserId } : {}) },
        }
      } catch (error) {
        return { type: "failed", error: error instanceof Error ? error.message : "The Notion session in this machine's browser could not be read." }
      }
    },
  }
}

// browserReader is the sign-in a request runs with: a session taken from a
// browser is read again, since the browser may have signed in again since it was
// kept. A read that fails keeps the session that was saved rather than failing
// the request, and the workspace is rediscovered from the session itself.
//
// Reading a browser is not free - a store is copied and opened, or a running
// browser is asked over its debugging port, which can take seconds on a busy
// machine - so an answer is reused for a while instead of on every request, and
// a request that came back unauthorized drops it at once: a sign-in that has
// been renewed in the browser is then picked up on the very next request.
export function browserReader(session, windowMs) {
  let last
  return {
    async read(auth) {
      if (typeof auth?.metadata?.browser !== "string") return auth
      if (last && Date.now() - last.at < windowMs) return last.auth
      try {
        const found = await session.findSession()
        last = {
          at: Date.now(),
          auth: {
            ...auth,
            key: found.cookie,
            metadata: { ...auth.metadata, browser: found.browser, profile: found.profile, ...(found.via ? { via: found.via } : {}), ...(found.activeUserId ? { activeUserId: found.activeUserId } : {}) },
          },
        }
        return last.auth
      } catch {
        return auth
      }
    },
    forget() {
      last = undefined
    },
  }
}

export function createPlugin(protocol, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000
  const browserReadMs = options.browserReadMs ?? 60_000
  const session = options.session ?? localSession
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) throw new Error("Notion timeoutMs must be between 1000 and 3600000 milliseconds.")
  if (!Number.isSafeInteger(browserReadMs) || browserReadMs < 0) throw new Error("Notion browserReadMs must be zero or more whole milliseconds.")
  const reader = browserReader(session, browserReadMs)
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: "Notion AI",
        npm: "@ai-sdk/openai-compatible",
        api: VIRTUAL_API,
        models: { "omniberry-sundae": { name: "GPT-6.1 Sol", tool_call: false, attachment: false, modalities: { input: ["text"], output: ["text"] } } },
      }
    },
    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [
        { type: "oauth", label: "Use the Notion session in this browser", authorize: () => browserSignIn(session) },
        {
          type: "api",
          label: "Notion web session (paste the Cookie header)",
          prompts: [
            { type: "text", key: "spaceId", message: "Notion workspace id (optional UUID; blank finds it from the session)", placeholder: "(blank)", validate: (value) => !value || UUID.test(value) ? undefined : "Enter the workspace's UUID, or leave blank to find it from the session." },
            { type: "text", key: "activeUserId", message: "Notion active user UUID (optional; blank for the session default)", placeholder: "(blank)", validate: (value) => !value || UUID.test(value) ? undefined : "Enter a user UUID or leave blank." },
          ],
        },
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
              const auth = await reader.read(await getAuth())
              const events = await protocol.open({ auth, chat, signal: scope.signal })
              const chunks = completionChunks(events, chat.model, scope.signal)
              if (chat.stream) return streamResponse(chunks, scope.close)
              try { return await bufferedResponse(chunks) } finally { scope.close() }
            } catch (error) {
              if (scope?.signal.aborted && scope.signal.reason instanceof ProviderError) error = scope.signal.reason
              scope?.close()
              if (error?.status === 401) reader.forget()
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
          return await protocol.usage({ auth: await reader.read(await getAuth()) })
        } catch {
          return { error: "The Notion AI quota could not be read.", windows: [] }
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

export const _internal = { parseChat, completionChunks, streamResponse, bufferedResponse, publicError, scopedSignal, errorResponse, browserReader }
