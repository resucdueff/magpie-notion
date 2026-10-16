import { test, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { createPlugin } from "../core.mjs"
import protocol, { _internal as internals } from "../protocol.mjs"
import { readNDJSON, transcriptEvents } from "../transcript.mjs"
import { NotionPlugin } from "../index.mjs"

const originalFetch = globalThis.fetch
const uuid = "11111111-1111-4111-8111-111111111111"
const user = "22222222-2222-4222-8222-222222222222"
const auth = { type: "api", key: "test_session=not-a-real-cookie", metadata: { spaceId: uuid } }
const model = { model: "test-model", modelMessage: "Offline test", agentService: {}, modelConfiguration: { supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" } }
const chat = (messages = [{ role: "user", content: "First" }], more = {}) => ({ model: model.model, messages, ...more })
const message = (text, sequence = 1, id = "assistant") => ({ op: "put", entity: { id, kind: "assistant_message", sequence, content: [{ type: "text", text }] } })
const done = (sequence = 2, reason = "end_turn") => ({ op: "put", entity: { id: "done-" + sequence, kind: "turn_completed", sequence, stop_reason: reason } })
const frame = (...patches) => ({ type: "agent_service_transcript_delta", patches })
const page = (patches = [], sequence = 0, status = "running") => ({ type: "agent_service_transcript_page", patches, session: { sequence, status }, forward_cursor: "offline-cursor" })
const collect = async (iterable) => { const out = []; for await (const item of iterable) out.push(item); return out }
const iterable = async function* (values) { yield* values }
const ndjson = (frames) => new Response(frames.map((v) => JSON.stringify(v)).join("\n") + "\n")

function mockNotion(options = {}) {
  const calls = []
  let creates = 0
  let sends = 0
  globalThis.fetch = async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    const data = JSON.parse(init.body)
    calls.push({ name, data, init, url: String(url) })
    if (options.handle) { const custom = await options.handle(name, data, calls); if (custom) return custom }
    if (name === "authValidate") return Response.json({})
    if (name === "getAvailableModels") return Response.json({ models: [model] })
    if (name === "createAgentThread") { creates++; return Response.json({ threadId: data.threadId }) }
    if (name === "sendEventToAgentThread") { sends++; return Response.json({}) }
    if (name === "getThreadTranscript") return Response.json(page([], sends ? 2 : 0, sends ? "idle" : "running"))
    if (name === "listenToThreadTranscript") return ndjson([frame(message(sends ? "Second answer" : "First answer", sends ? 3 : 1), done(sends ? 4 : 2))])
    throw new Error("Unexpected offline endpoint " + name)
  }
  return { calls, get creates() { return creates }, get sends() { return sends } }
}

async function request(body, options = {}) {
  const plugin = options.plugin ?? createPlugin(protocol)
  const loader = await plugin.auth.loader(async () => options.auth ?? auth)
  return loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer client-secret-never-forward" }, body: JSON.stringify(body), signal: options.signal })
}

async function firstTurn() {
  const result = await (await request(chat())).json()
  expect(result.choices[0].message.content).toBe("First answer")
  return [...chat().messages, result.choices[0].message, { role: "user", content: "Second" }]
}

beforeEach(() => { internals.sessions.clear(); internals.catalogs.clear() })
afterEach(() => { globalThis.fetch = originalFetch })

test("real redacted capture survives one-byte UTF-8 chunk boundaries", async () => {
const source = readFileSync(new URL("../fixtures/real-stream.ndjson", import.meta.url))
  const body = new ReadableStream({ start(c) { for (const byte of source) c.enqueue(Uint8Array.of(byte)); c.close() } })
  const events = await collect(transcriptEvents(readNDJSON(body)))
  expect(events.filter((v) => v.type === "done")).toHaveLength(1)
  expect(events.filter((v) => v.type === "text").map((v) => v.text).join("")).toBe("MAGPIE\\_NOTION\\_OK")
})

test("NDJSON handles Unicode split inside encoded character and final line without newline", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(frame(message("hello \u4e2d\u6587"), done())))
  const body = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close() } })
  const events = await collect(transcriptEvents(readNDJSON(body)))
  expect(events[0].text).toBe("hello \u4e2d\u6587")
})

test("provisional replacement is deduplicated", async () => {
  const events = await collect(transcriptEvents(iterable([frame(message("Hello", 1, "provisional")), frame({ op: "remove", id: "provisional" }, message("Hello", 1, "committed"), done())])))
  expect(events.filter((v) => v.type === "text").map((v) => v.text).join("")).toBe("Hello")
})

test("transcript rewrite fails explicitly", async () => {
  await expect(collect(transcriptEvents(iterable([frame(message("One")), frame(message("Other"), done())])))).rejects.toMatchObject({ code: "transcript_rewritten" })
})

test("EOF without turn completion is an error", async () => {
  await expect(collect(transcriptEvents(iterable([frame(message("partial"))])))).rejects.toMatchObject({ code: "incomplete_upstream" })
})

test("unknown patch operations fail closed", async () => {
  await expect(collect(transcriptEvents(iterable([frame({ op: "replace_all" })])))).rejects.toMatchObject({ code: "invalid_transcript" })
})

test("unknown notification frames do not terminate or fabricate a response", async () => {
  const events = await collect(transcriptEvents(iterable([{ type: "heartbeat" }, frame(message("answer"), done())])))
  expect(events.map((v) => v.type)).toEqual(["text", "done"])
})

test("unknown completion reasons fail closed", async () => {
  await expect(collect(transcriptEvents(iterable([frame(message("partial"), done(2, "quota_exceeded"))])))).rejects.toMatchObject({ code: "unsupported_stop_reason" })
})

test("malformed NDJSON is sanitized", async () => {
  await expect(collect(readNDJSON(new Response('{"secret":"fixture-only"\n').body))).rejects.toMatchObject({ code: "invalid_transcript" })
})

test("JSON mode returns text, finish reason, id and requested model", async () => {
  mockNotion()
  const response = await request(chat())
  const value = await response.json()
  expect(response.status).toBe(200)
  expect(value).toMatchObject({ object: "chat.completion", model: model.model, choices: [{ index: 0, message: { role: "assistant", content: "First answer" }, finish_reason: "stop" }] })
  expect(value.id).toStartWith("chatcmpl-")
})

test("SSE has stable metadata, an assistant role, a finish frame and exactly one DONE", async () => {
  mockNotion()
  const response = await request(chat(undefined, { stream: true }))
  const frames = (await response.text()).trim().split("\n\n").map((line) => line.slice(6))
  expect(response.headers.get("Content-Type")).toContain("text/event-stream")
  expect(frames.filter((v) => v === "[DONE]")).toHaveLength(1)
  const values = frames.filter((v) => v !== "[DONE]").map(JSON.parse)
  expect(values[0].choices[0].delta.role).toBe("assistant")
  expect(values.at(-1).choices[0].finish_reason).toBe("stop")
  expect(new Set(values.map((v) => v.id)).size).toBe(1)
})

test("SSE partial failure yields sanitized error and no success marker", async () => {
  mockNotion({ handle: (name) => name === "listenToThreadTranscript" ? ndjson([frame(message("partial"))]) : undefined })
  const response = await request(chat(undefined, { stream: true }))
  const text = await response.text()
  expect(text).toContain('"code":"incomplete_upstream"')
  expect(text).not.toContain("[DONE]")
})

test("exact continuation sends only last user text on existing thread", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => name === "getThreadTranscript" && calls.filter((v) => v.name === "createAgentThread").length === 1 && calls.filter((v) => v.name === "getThreadTranscript").length === 2 ? Response.json(page([], 2, "idle")) : undefined })
  await request(chat(await firstTurn()))
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
  expect(mock.calls.find((v) => v.name === "sendEventToAgentThread").data.event.content[0].text).toEqual([["Second"]])
})

test.each(["cookie", "workspace", "active-user", "model-effort", "history"])("history isolation: %s starts a fresh thread", async (dimension) => {
  const mock = mockNotion()
  const history = await firstTurn()
  let nextAuth = structuredClone(auth)
  const extra = {}
  if (dimension === "cookie") nextAuth.key = "other-test-session"
  if (dimension === "workspace") nextAuth.metadata.spaceId = user
  if (dimension === "active-user") nextAuth.metadata.activeUserId = user
  if (dimension === "model-effort") extra.reasoning_effort = "high"
  if (dimension === "history") history[0].content = "Different first prompt"
  await (await request(chat(history, extra), { auth: nextAuth })).json()
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(0)
})

test("a stale or running Notion thread starts a fresh thread", async () => {
  const mock = mockNotion()
  await (await request(chat(await firstTurn()))).json()
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(0)
})

test("a cached history may advance only once", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length === 2 ? Response.json(page([], 2, "idle")) : undefined })
  const history = await firstTurn()
  await (await request(chat(history))).json()
  await (await request(chat(history))).json()
  expect(mock.sends).toBe(1)
  expect(mock.creates).toBe(2)
})

test("model identity isolates otherwise identical client history", async () => {
  const mock = mockNotion({ handle: (name) => name === "getAvailableModels" ? Response.json({ models: [model, { ...model, model: "other-model" }] }) : undefined })
  await (await request(chat(await firstTurn(), { model: "other-model" }))).json()
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(0)
})

test("concurrent branches cannot both advance the same cached history", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length === 2 ? Response.json(page([], 2, "idle")) : undefined })
  const history = await firstTurn()
  const responses = await Promise.all([request(chat(history)), request(chat(history))])
  for (const response of responses) await response.json()
  expect(mock.sends).toBe(1)
  expect(mock.creates).toBe(2)
})

test("expired history starts a new thread", async () => {
  const mock = mockNotion()
  const history = await firstTurn()
  for (const cached of internals.sessions.values()) cached.at -= 31 * 60 * 1000
  await (await request(chat(history))).json()
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(0)
})

test("transport exceptions never expose private diagnostics", async () => {
  globalThis.fetch = async () => { throw new Error("private-session-and-workspace-diagnostic") }
  const response = await request(chat())
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain("private-session-and-workspace-diagnostic")
})

test("old committed page records cannot terminate the next turn", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => {
    if (name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length >= 2) return Response.json(page([message("First answer"), done()], 2, "idle"))
  } })
  const response = await request(chat(await firstTurn()))
  expect((await response.json()).choices[0].message.content).toBe("Second answer")
  expect(mock.sends).toBe(1)
})

test("a replayed completion in live deltas cannot terminate the next turn", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => {
    if (name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length >= 2) return Response.json(page([], 2, "idle"))
    if (name === "listenToThreadTranscript" && calls.some((v) => v.name === "sendEventToAgentThread")) return ndjson([frame(done(2)), frame(message("Second answer", 3), done(4))])
  } })
  const response = await request(chat(await firstTurn()))
  expect((await response.json()).choices[0].message.content).toBe("Second answer")
  expect(mock.sends).toBe(1)
})

test("a malformed completion without a committed sequence is rejected", async () => {
  const malformed = done()
  delete malformed.entity.sequence
  mockNotion({ handle: (name) => name === "listenToThreadTranscript" ? ndjson([frame(message("answer"), malformed)]) : undefined })
  const response = await request(chat())
  expect(response.status).toBe(502)
  expect(internals.sessions.size).toBe(0)
})

test.each([[401, "session_expired"], [403, "workspace_forbidden"], [429, "rate_limited"], [402, "upstream_http_error"]])("HTTP %i is preserved with %s and no upstream secrets", async (status, code) => {
  mockNotion({ handle: () => new Response("upstream-private-account-data", { status }) })
  const response = await request(chat())
  const body = await response.text()
  expect(response.status).toBe(status)
  expect(body).toContain(code)
  expect(body).not.toContain("upstream-private-account-data")
})

test("catalog restrictions and disabled models are respected without static fallback", async () => {
  mockNotion({ handle: (name) => name === "getAvailableModels" ? Response.json({ models: [model, { ...model, model: "disabled", isDisabled: true }, { ...model, model: "restricted", restrictedForPersonalAgent: true }, { ...model, model: "not-agent", agentService: null }] }) : undefined })
  const models = await protocol.models({ auth })
  expect(Object.keys(models)).toEqual([model.model])
  const response = await request(chat(undefined, { model: "omniberry-sundae" }))
  expect(response.status).toBe(403)
})

test("workspace-wide model restriction yields no eligible models", async () => {
  mockNotion({ handle: () => Response.json({ models: [model], modelSelectionRestricted: true }) })
  expect(await protocol.models({ auth })).toEqual({})
})

test("catalog outage cannot be replaced by a static model", async () => {
  mockNotion({ handle: () => new Response("Unavailable", { status: 503 }) })
  expect((await request(chat(undefined, { model: "omniberry-sundae" }))).status).toBe(503)
})

test("invalid auth and UUID metadata fail before any network request", async () => {
  const mock = mockNotion()
  // A workspace that is absent is not an error: it is discovered from the
  // session (test/workspace.test.mjs). A workspace that is not a UUID still is.
  for (const invalidAuth of [{ type: "api", key: "x\r\ny", metadata: { spaceId: uuid } }, { type: "api", key: "  ", metadata: {} }, { ...auth, metadata: { spaceId: uuid, activeUserId: "invalid" } }, { ...auth, metadata: { spaceId: "not-a-uuid" } }]) {
    expect((await request(chat(), { auth: invalidAuth })).status).toBeGreaterThanOrEqual(400)
  }
  expect(mock.calls).toHaveLength(0)
})

test("incoming credentials are not forwarded, and safe agent settings are present", async () => {
  const mock = mockNotion()
  await request(chat(), { auth: { ...auth, metadata: { ...auth.metadata, activeUserId: user } } })
  expect(mock.calls.every((v) => v.url.startsWith("https://app.notion.com/api/v3/"))).toBe(true)
  for (const call of mock.calls) {
    expect(call.init.headers.Authorization).toBeUndefined()
    expect(call.init.headers.Cookie).toBe(auth.key)
    expect(call.init.headers["x-notion-active-user-header"]).toBe(user)
    expect(call.init.redirect).toBe("error")
  }
  expect(mock.calls.find((v) => v.name === "createAgentThread").data).toMatchObject({ policies: { approval_mode: "ask", disable_internet_access: true, disable_computer_file_downloads: true }, agentMemorySettings: { useMemories: false, excludeChatFromMemories: true }, browserEnabled: false })
})

test.each([{ tools: [{ type: "function" }] }, { messages: [{ role: "tool", content: "tool" }] }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "secret" } }] }] }])("unsupported tools and images fail before network", async (input) => {
  const mock = mockNotion()
  expect((await request(chat(undefined, input))).status).toBe(400)
  expect(mock.calls).toHaveLength(0)
})

test("package entry exports only the plugin and all declared runtime files exist", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
  expect(Object.keys(await import("../index.mjs"))).toEqual(["NotionPlugin"])
  expect((await NotionPlugin()).auth.provider).toBe("notion")
  for (const file of pkg.files) expect(existsSync(new URL("../" + file, import.meta.url))).toBe(true)
  expect(pkg.files).not.toContain("independent.test.mjs")
  // standalone repository: it ships as a public npm package with a magpie icon
  expect(pkg.private).not.toBe(true)
  expect(pkg.magpie?.icon?.startsWith("data:image/")).toBe(true)
})

test("cancelling SSE aborts an upstream read waiting on the request signal", async () => {
  let upstreamAborted = false
  let listenStarted
  const started = new Promise((resolve) => { listenStarted = resolve })
  mockNotion({ handle: (name, data, calls) => {
    if (name !== "listenToThreadTranscript") return
    const signal = calls.at(-1).init.signal
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(frame(message("Started"))) + "\n")); signal.addEventListener("abort", () => { upstreamAborted = true; c.error(signal.reason) }, { once: true }); listenStarted() } }))
  } })
  const response = await request(chat(undefined, { stream: true }))
  const reader = response.body.getReader()
  await reader.read()
  const pending = reader.read()
  await started
  await reader.cancel("offline client cancellation")
  await pending
  expect(upstreamAborted).toBe(true)
})

test("NDJSON signal abort cancels a pending reader even when the source never yields", async () => {
  const abort = new AbortController()
  let controller
  let cancelled = false
  const body = new ReadableStream({ start(c) { controller = c }, cancel() { cancelled = true } })
  const iterator = readNDJSON(body, abort.signal)
  const next = iterator.next().then(() => "resolved", () => "aborted")
  await new Promise((resolve) => setTimeout(resolve, 0))
  abort.abort(new Error("offline-abort"))
  const result = await Promise.race([next, new Promise((resolve) => setTimeout(() => resolve("blocked"), 30))])
  if (result === "blocked") controller.close()
  await next
  await iterator.return()
  expect(result).toBe("aborted")
  expect(cancelled).toBe(true)
})

test.each([["notion_exhausted", "credits_exhausted"], ["chatgpt_exhausted", "connected_plan_exhausted"]])("current %s allowance returns HTTP 402 before SSE commits", async (field, code) => {
  mockNotion({ handle: (name) => name === "getThreadTranscript" ? Response.json({ ...page(), session: { sequence: 1, last_turn_allowance: { sequence: 1, [field]: true, sensitive_diagnostic: "private-credit-diagnostic" } } }) : undefined })
  const response = await request(chat(undefined, { stream: true }))
  const text = await response.text()
  expect(response.status).toBe(402)
  expect(text).toContain(code)
  expect(text).not.toContain("private-credit-diagnostic")
  expect(text).not.toContain("[DONE]")
})

test("stale allowance from an old turn cannot reject a new continuation", async () => {
  mockNotion({ handle: (name, data, calls) => {
    if (name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length >= 2) return Response.json({ ...page([], 2, "idle"), session: { sequence: 2, status: "idle", last_turn_allowance: { sequence: 2, notion_exhausted: true } } })
  } })
  const response = await request(chat(await firstTurn()))
  expect(response.status).toBe(200)
  expect((await response.json()).choices[0].message.content).toBe("Second answer")
})

test.each([
  [{ op: "session", session: { sequence: 1, pending_input: { private: "private-tool-request" } } }, 409, "notion_action_required"],
  [{ op: "put", entity: { id: "error", kind: "error", sequence: 1, message: "private-tool-request" } }, 502, "notion_agent_error"],
  [{ op: "put", entity: { id: "upgrade", kind: "client_update_required", sequence: 1 } }, 502, "notion_client_update_required"],
  [{ op: "put", entity: { id: "connection", kind: "status", sequence: 1, status: "per_user_connection_required" } }, 409, "connection_required"],
])("action/error events are classified and sanitized in buffered and SSE modes", async (patch, status, code) => {
  for (const stream of [false, true]) {
    mockNotion({ handle: (name) => name === "listenToThreadTranscript" ? ndjson([frame(patch)]) : undefined })
    const response = await request(chat(undefined, { stream }))
    const text = await response.text()
    expect(response.status).toBe(stream ? 200 : status)
    expect(text).toContain(code)
    expect(text).not.toContain("private-tool-request")
    expect(text).not.toContain("[DONE]")
  }
})

test("model enumeration validates session HTTP status before using a catalog", async () => {
  const mock = mockNotion({ handle: (name) => name === "authValidate" ? new Response(null, { status: 204 }) : undefined })
  await expect(protocol.models({ auth })).rejects.toMatchObject({ status: 401, code: "session_expired" })
  expect(mock.calls.map((v) => v.name)).toEqual(["authValidate"])
})

test("total request timeout aborts a stalled upstream with a sanitized 504", async () => {
  const stalled = { async open({ signal }) { return (async function* () {
    await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }) })
    yield { type: "done" }
  })() } }
  const response = await request(chat(), { plugin: createPlugin(stalled, { timeoutMs: 1000 }) })
  expect(response.status).toBe(504)
  expect((await response.json()).error.code).toBe("request_timeout")
})
