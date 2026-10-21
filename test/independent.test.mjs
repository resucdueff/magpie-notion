import { test, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { createPlugin } from "../core.mjs"
import protocol, { _internal as internals } from "../protocol.mjs"
import { readNDJSON, transcriptEvents } from "../transcript.mjs"
import { NotionPlugin } from "../index.mjs"

const uuid = "11111111-1111-4111-8111-111111111111"
const user = "22222222-2222-4222-8222-222222222222"
const token = "offline-token-v2"
const auth = { type: "api", key: token, metadata: { spaceId: uuid } }
const model = { model: "test-model", modelMessage: "Offline test", agentService: {}, modelConfiguration: { supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" } }
const chat = (messages = [{ role: "user", content: "First" }], more = {}) => ({ model: model.model, messages, ...more })
const message = (text, sequence = 1, id = "assistant") => ({ op: "put", entity: { id, kind: "assistant_message", sequence, content: [{ type: "text", text }] } })
const done = (sequence = 2, reason = "end_turn") => ({ op: "put", entity: { id: "done-" + sequence, kind: "turn_completed", sequence, stop_reason: reason } })
const frame = (...patches) => ({ type: "agent_service_transcript_delta", patches })
const page = (patches = [], sequence = 0, status = "running", extra = {}) => ({ type: "agent_service_transcript_page", patches, session: { sequence, status }, forward_cursor: "offline-cursor", ...extra })
const collect = async (iterable) => { const out = []; for await (const item of iterable) out.push(item); return out }
const iterable = async function* (values) { yield* values }
const ndjson = (frames) => new Response(frames.map((v) => JSON.stringify(v)).join("\n") + "\n")
const cookieValue = (header, name) => header.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1)

function mockNotion(options = {}) {
  const calls = []
  let creates = 0
  let sends = 0
  internals.useFetch(async (url, init) => {
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
  })
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

beforeEach(() => { internals.sessions.clear(); internals.catalogs.clear(); internals.resolved.clear() })
afterEach(() => { internals.useFetch(undefined) })

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

test("a failed transcript read keeps the same history reusable", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => {
    if (name !== "getThreadTranscript") return
    const reads = calls.filter((v) => v.name === "getThreadTranscript").length
    if (reads === 2) return new Response(null, { status: 503 })
    if (reads === 3) return Response.json(page([], 2, "idle"))
  } })
  const history = await firstTurn()
  expect((await request(chat(history))).status).toBe(503)
  expect(internals.sessions.size).toBe(1)
  const retried = await request(chat(history))
  expect((await retried.json()).choices[0].message.content).toBe("Second answer")
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
})

test.each(["cookie", "workspace", "active-user", "model-effort", "history"])("history isolation: %s starts a fresh thread", async (dimension) => {
  const mock = mockNotion()
  const history = await firstTurn()
  let nextAuth = structuredClone(auth)
  const extra = {}
  if (dimension === "cookie") nextAuth.key = "other-" + token
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

test("a divergent cached transcript is forgotten instead of probed on every retry", async () => {
  let originalThreadId
  let originalReads = 0
  const mock = mockNotion({ handle: (name, data) => {
    if (name === "createAgentThread" && originalThreadId === undefined) originalThreadId = data.threadId
    if (name === "getThreadTranscript" && data.threadId === originalThreadId && ++originalReads === 2) return Response.json(page([], 3, "idle"))
  } })
  const history = await firstTurn()
  await (await request(chat(history))).json()
  await (await request(chat(history))).json()
  expect(mock.creates).toBe(3)
  expect(mock.sends).toBe(0)
  expect(mock.calls.filter((call) => call.name === "getThreadTranscript" && call.data.threadId === originalThreadId)).toHaveLength(2)
})

test("a temporarily running thread stays cached for a later continuation", async () => {
  let originalThreadId
  let originalReads = 0
  const mock = mockNotion({ handle: (name, data) => {
    if (name === "createAgentThread" && originalThreadId === undefined) originalThreadId = data.threadId
    if (name !== "getThreadTranscript" || data.threadId !== originalThreadId) return
    originalReads++
    if (originalReads === 2) return Response.json(page([], 2, "running"))
    if (originalReads === 3) return Response.json(page([], 2, "idle"))
  } })
  const history = await firstTurn()
  await (await request(chat(history))).json()
  await (await request(chat(history))).json()
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(1)
  expect(mock.calls.find((call) => call.name === "sendEventToAgentThread").data.threadId).toBe(originalThreadId)
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
  internals.useFetch(async () => { throw new Error("private-session-and-workspace-diagnostic") })
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

test("a completed backward page is joined with the earlier answer page", async () => {
  const mock = mockNotion({ handle: (name, data) => {
    if (name !== "getThreadTranscript") return
    if (data.cursor === "older-page") return Response.json(page([message("Earlier answer", 3)], 3, "idle", { has_more_backward: false }))
    return Response.json(page([done(4)], 4, "idle", { backward_cursor: "older-page", has_more_backward: true }))
  } })
  const response = await request(chat())
  expect((await response.json()).choices[0].message.content).toBe("Earlier answer")
  expect(mock.calls.filter((call) => call.name === "getThreadTranscript").map((call) => call.data.cursor)).toEqual([undefined, "older-page"])
  expect(mock.calls.filter((call) => call.name === "listenToThreadTranscript")).toHaveLength(0)
})

test.each([[401, "session_expired"], [403, "workspace_forbidden"], [429, "rate_limited"], [402, "upstream_http_error"]])("HTTP %i is preserved with %s and no upstream secrets", async (status, code) => {
  mockNotion({ handle: () => new Response("upstream-private-account-data", { status }) })
  const response = await request(chat())
  const body = await response.text()
  expect(response.status).toBe(status)
  expect(body).toContain(code)
  expect(body).not.toContain("upstream-private-account-data")
})

test("an idempotent read retries a short Retry-After", async () => {
  let attempts = 0
  mockNotion({ handle: (name) => name === "authValidate" && ++attempts === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "0" } }) : undefined })
  expect(Object.keys(await protocol.models({ auth }))).toEqual([model.model])
  expect(attempts).toBe(2)
})

test("a read retries at most twice and preserves Retry-After on the final 429", async () => {
  const mock = mockNotion({ handle: (name) => name === "getThreadTranscript" ? new Response(null, { status: 429, headers: { "Retry-After": "0" } }) : undefined })
  const response = await request(chat())
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("0")
  expect(response.headers.get("X-Magpie-Sign-In")).toBeNull()
  expect(mock.calls.filter((call) => call.name === "getThreadTranscript")).toHaveLength(3)
  expect(await response.text()).not.toContain("session_expired")
})

test.each(["10", "Wed, 21 Oct 2015 07:28:00 GMT"])("a long or date Retry-After is returned without retrying: %s", async (retryAfter) => {
  const mock = mockNotion({ handle: (name) => name === "getThreadTranscript" ? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }) : undefined })
  const response = await request(chat())
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe(retryAfter)
  expect(mock.calls.filter((call) => call.name === "getThreadTranscript")).toHaveLength(1)
})

test("503 is not retried", async () => {
  const mock = mockNotion({ handle: (name) => name === "getThreadTranscript" ? new Response(null, { status: 503 }) : undefined })
  expect((await request(chat())).status).toBe(503)
  expect(mock.calls.filter((call) => call.name === "getThreadTranscript")).toHaveLength(1)
})

test("thread creation is not retried on 429", async () => {
  const mock = mockNotion({ handle: (name) => name === "createAgentThread" ? new Response(null, { status: 429, headers: { "Retry-After": "0" } }) : undefined })
  const response = await request(chat())
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("0")
  expect(mock.calls.filter((call) => call.name === "createAgentThread")).toHaveLength(1)
})

test("sending a thread event is not retried on 429", async () => {
  const mock = mockNotion({ handle: (name, data, calls) => {
    if (name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length === 2) return Response.json(page([], 2, "idle"))
    if (name === "sendEventToAgentThread") return new Response(null, { status: 429, headers: { "Retry-After": "0" } })
  } })
  const history = await firstTurn()
  const response = await request(chat(history))
  expect(response.status).toBe(429)
  expect(response.headers.get("Retry-After")).toBe("0")
  expect(mock.calls.filter((call) => call.name === "sendEventToAgentThread")).toHaveLength(1)
  expect(mock.creates).toBe(1)
  expect(internals.sessions.size).toBe(1)
})

test("catalog restrictions and disabled models are respected without static fallback", async () => {
  mockNotion({ handle: (name) => name === "getAvailableModels" ? Response.json({ models: [model, { ...model, model: "disabled", isDisabled: true }, { ...model, model: "restricted", restrictedForPersonalAgent: true }, { ...model, model: "not-agent", agentService: null }] }) : undefined })
  const models = await protocol.models({ auth })
  expect(Object.keys(models)).toEqual([model.model])
  const response = await request(chat(undefined, { model: "omniberry-sundae" }))
  expect(response.status).toBe(403)
  expect((await response.json()).error.message).toContain("Refresh the model list")
})

test("the pre-login placeholder keeps its id and explains how to refresh", async () => {
  const config = {}
  await createPlugin(protocol).config(config)
  expect(config.provider.notion.models["omniberry-sundae"]).toMatchObject({ name: "Notion AI（登录后刷新模型列表）", tool_call: false })
})

test("workspace-wide model restriction yields no eligible models", async () => {
  mockNotion({ handle: () => Response.json({ models: [model], modelSelectionRestricted: true }) })
  expect(await protocol.models({ auth })).toEqual({})
})

test("catalog outage cannot be replaced by a static model", async () => {
  mockNotion({ handle: () => new Response("Unavailable", { status: 503 }) })
  expect((await request(chat(undefined, { model: "omniberry-sundae" }))).status).toBe(503)
})

test("a raw token and a pasted Cookie both keep only token_v2", () => {
  expect(internals.credentials({ type: "api", key: token })).toMatchObject({ cookie: `token_v2=${token}` })
  expect(internals.credentials({ type: "api", key: `Cookie: token_v2=${token}; notion_user_id=ignored` })).toMatchObject({ cookie: `token_v2=${token}` })
})

test("invalid pasted tokens and UUID metadata fail before any network request", async () => {
  const mock = mockNotion()
  for (const invalidAuth of [
    { type: "api", key: "x\r\ny", metadata: { spaceId: uuid } },
    { type: "api", key: "  ", metadata: {} },
    { type: "api", key: "token_v2=", metadata: {} },
    { type: "api", key: "notion_user_id=no-token-here", metadata: {} },
  ]) {
    const response = await request(chat(), { auth: invalidAuth })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain("请粘贴 Notion 的 token_v2。")
  }
  const pasted = "private-pasted-token\r\nmust-not-leak"
  const leaked = await request(chat(), { auth: { type: "api", key: pasted, metadata: {} } })
  const leakedBody = await leaked.text()
  expect(leaked.status).toBe(401)
  expect(leakedBody).toContain("请粘贴 Notion 的 token_v2。")
  expect(leakedBody).not.toContain("private-pasted-token")
  expect((await request(chat(), { auth: { ...auth, metadata: { spaceId: uuid, activeUserId: "invalid" } } })).status).toBe(400)
  expect((await request(chat(), { auth: { ...auth, metadata: { spaceId: "not-a-uuid" } } })).status).toBe(400)
  expect(mock.calls).toHaveLength(0)
})

test("control characters are refused without echoing the pasted token", async () => {
  const mock = mockNotion()
  for (const control of ["\x00", "\x1f", "\x7f"]) {
    const secret = `private${control}token`
    const response = await request(chat(), { auth: { type: "api", key: `token_v2=${secret}`, metadata: {} } })
    const body = await response.text()
    expect(response.status).toBe(401)
    expect(body).toContain("请粘贴 Notion 的 token_v2。")
    expect(body).not.toContain("private")
  }
  expect(mock.calls).toHaveLength(0)
})

test("incoming credentials are not forwarded, and safe agent settings are present", async () => {
  const mock = mockNotion()
  const pasted = `token_v2=${token}; notion_user_id=unrelated-cookie`
  await request(chat(), { auth: { ...auth, key: pasted, metadata: { ...auth.metadata, activeUserId: user } } })
  expect(mock.calls.every((v) => v.url.startsWith("https://app.notion.com/api/v3/"))).toBe(true)
  for (const call of mock.calls) {
    expect(call.init.headers.Authorization).toBeUndefined()
    expect(cookieValue(call.init.headers.Cookie, "token_v2")).toBe(token)
    expect(call.init.headers.Cookie).toContain("notion_users=" + encodeURIComponent(JSON.stringify([user])))
    expect(call.init.headers["x-notion-active-user-header"]).toBe(user)
    expect(call.init.redirect).toBe("error")
    expect(call.init.headers.Cookie).not.toContain("unrelated-cookie")
  }
  expect(mock.calls.find((v) => v.name === "createAgentThread").data).toMatchObject({ policies: { approval_mode: "ask", disable_internet_access: true, disable_computer_file_downloads: true }, agentMemorySettings: { useMemories: false, excludeChatFromMemories: true }, browserEnabled: false })
})

test("client tool declarations are dropped and the text request still completes", async () => {
  const mock = mockNotion()
  const response = await request(chat([{ role: "user", content: "Hello" }], {
    tools: [{ type: "function", function: { name: "shell", parameters: { secret_schema: true } } }],
    tool_choice: "required",
    functions: [{ name: "legacy" }],
    function_call: "auto",
  }))
  expect(response.status).toBe(200)
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  const sent = JSON.stringify(created.data)
  expect(sent).toContain("Hello")
  expect(sent).not.toContain("shell")
  expect(sent).not.toContain("secret_schema")
  expect(sent).not.toContain("legacy")
})

test("earlier tool calls and results are kept as text", async () => {
  const mock = mockNotion()
  const response = await request(chat([
    { role: "user", content: "Run it" },
    { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" } }] },
    { role: "tool", name: "shell", content: "file.txt" },
  ]))
  expect(response.status).toBe(200)
  const sent = JSON.stringify(mock.calls.find((call) => call.name === "createAgentThread").data)
  expect(sent).toContain("file.txt")
  expect(sent).toContain("shell")
  expect(sent).toContain("ls")
})

test("images still fail before network", async () => {
  const mock = mockNotion()
  expect((await request(chat(undefined, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "secret" } }] }] }))).status).toBe(400)
  expect(mock.calls).toHaveLength(0)
})

test("package entry exports only the plugin and all declared runtime files exist", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
  const plugin = await NotionPlugin()
  expect(Object.keys(await import("../index.mjs"))).toEqual(["NotionPlugin"])
  expect(pkg).toMatchObject({ name: "magpie-notion", version: "1.0.6" })
  expect(pkg.description).toContain("token_v2")
  expect(plugin.auth.provider).toBe("notion")
  expect(plugin.auth.methods).toEqual([{ type: "api", label: "粘贴 token_v2", placeholder: "只粘贴 token_v2" }])
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

test("model enumeration accepts a successful authValidate response without a body", async () => {
  const mock = mockNotion({ handle: (name) => name === "authValidate" ? new Response(null, { status: 204 }) : undefined })
  expect(Object.keys(await protocol.models({ auth }))).toEqual([model.model])
  expect(mock.calls.map((v) => v.name)).toEqual(["authValidate", "getAvailableModels"])
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

test("a committed answer shorter than the provisional text is not a failure", async () => {
  const provisional = "Hello world, this is the provisional stream"
  const mock = mockNotion({ handle: (name, data, calls) => {
    if (name === "getThreadTranscript" && calls.filter((v) => v.name === "getThreadTranscript").length === 2) return Response.json(page([], 2, "idle"))
    if (name === "listenToThreadTranscript" && !calls.some((v) => v.name === "sendEventToAgentThread")) return ndjson([
      frame(message(provisional, 1, "provisional")),
      frame({ op: "remove", id: "provisional" }, message("Hello", 1, "committed"), done(2)),
    ])
  } })
  const response = await request(chat())
  expect(response.status).toBe(200)
  const first = await response.json()
  // Text already sent cannot be taken back, so this is also the text cached for
  // the next turn.
  expect(first.choices[0].message.content).toBe(provisional)
  const history = [...chat().messages, first.choices[0].message, { role: "user", content: "Second" }]
  const second = await (await request(chat(history))).json()
  expect(second.choices[0].message.content).toBe("Second answer")
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
})

test("a shorter committed answer keeps the stream that was already sent intact", async () => {
  mockNotion({ handle: (name) => name === "listenToThreadTranscript" ? ndjson([
    frame(message("Hello world, this is the provisional stream", 1, "provisional")),
    frame({ op: "remove", id: "provisional" }, message("Hello", 1, "committed"), done(2)),
  ]) : undefined })
  const response = await request(chat(undefined, { stream: true }))
  const text = await response.text()
  expect(response.status).toBe(200)
  expect(text).toContain("Hello world, this is the provisional stream")
  expect(text).not.toContain('"error"')
  expect(text).toContain("[DONE]")
})

test("done text is exactly the assistant text already yielded to the client", async () => {
  const events = await collect(transcriptEvents(iterable([
    frame(message("Hello world, this is the provisional stream", 1, "provisional")),
    frame({ op: "remove", id: "provisional" }, message("Hello", 1, "committed"), done(2)),
  ])))
  const streamed = events.filter((event) => event.type === "text").map((event) => event.text).join("")
  expect(events.at(-1)).toMatchObject({ type: "done", text: streamed })
})

test("a turn that ends without text is reported, not answered with nothing", async () => {
  const silent = frame({ op: "put", entity: { id: "assistant", kind: "assistant_message", sequence: 1, content: [{ type: "tool_use", id: "call" }] } }, done(2))
  for (const stream of [false, true]) {
    mockNotion({ handle: (name) => name === "listenToThreadTranscript" ? ndjson([silent]) : undefined })
    const response = await request(chat(undefined, { stream }))
    const text = await response.text()
    expect(response.status).toBe(stream ? 200 : 502)
    expect(text).toContain("empty_answer")
    expect(text).not.toContain("[DONE]")
  }
})

test("a burst of small frames in one read is not one oversized frame", async () => {
  const burst = '{"type":"keepalive"}\n'.repeat(210_000)
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(burst)); c.close() } })
  const frames = await collect(readNDJSON(body))
  expect(frames).toHaveLength(210_000)
})

test("a single frame over the frame limit is refused", async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"type":"keepalive","pad":"${"a".repeat(4 * 1024 * 1024)}"}\n`)); c.close() } })
  await expect(collect(readNDJSON(body))).rejects.toMatchObject({ code: "transcript_frame_too_large" })
})

test("a long answer is decoded without rebuilding the whole message each frame", async () => {
  async function* stream() {
    yield frame(message("a", 1, "assistant"))
    for (let index = 0; index < 100_000; index++) yield frame({ op: "patch", id: "assistant", ops: [{ op: "append", path: "/content/0/text", value: "x" }] })
    yield frame(done(2))
  }
  const started = performance.now()
  const events = await collect(transcriptEvents(stream()))
  const elapsed = performance.now() - started
  expect(events.at(-1)).toMatchObject({ type: "done", text: "a" + "x".repeat(100_000) })
  // Rebuilding on every frame took seconds at this size; decoding must stay
  // proportional to the fragments it is handed.
  expect(elapsed).toBeLessThan(4000)
})

test("a model without an id is never published", async () => {
  mockNotion({ handle: (name) => name === "getAvailableModels" ? Response.json({ models: [{ ...model, model: "" }, model] }) : undefined })
  const models = await protocol.models({ auth })
  expect(Object.keys(models)).toEqual([model.model])
})

test("the frame limit treats a CRLF boundary identically across network reads", async () => {
  const limit = 4 * 1024 * 1024
  const base = JSON.stringify({ type: "keepalive", pad: "" })
  const line = JSON.stringify({ type: "keepalive", pad: "x".repeat(limit - base.length) })
  const bytes = new TextEncoder().encode(line + "\r\n")
  for (const parts of [[bytes], [bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1)]]) {
    const body = new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close() } })
    const frames = await collect(readNDJSON(body))
    expect(frames).toHaveLength(1)
    expect(frames[0].pad.length).toBe(limit - base.length)
  }
})

test("oversized outer JSON whitespace cannot bypass the frame limit", async () => {
  const bytes = new TextEncoder().encode(" ".repeat(4 * 1024 * 1024) + "{}\n")
  for (const parts of [[bytes], [bytes.subarray(0, bytes.length - 2), bytes.subarray(bytes.length - 2)]]) {
    const body = new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close() } })
    await expect(collect(readNDJSON(body))).rejects.toMatchObject({ code: "transcript_frame_too_large" })
  }
})

test("an append inside multipart text fails before sending a misplaced delta", async () => {
  for (const index of [0, 1]) {
    const initial = message("A")
    initial.entity.content.push({ type: "text", text: "B" })
    const events = []
    let failure
    try {
      for await (const event of transcriptEvents(iterable([
        frame(initial),
        frame({ op: "patch", id: "assistant", ops: [{ op: "append", path: `/content/${index}/text`, value: "X" }] }),
        frame(done()),
      ]))) events.push(event)
    } catch (error) {
      failure = error
    }
    if (index === 0) {
      expect(failure?.code).toBe("transcript_rewritten")
      expect(events).toEqual([{ type: "text", text: "AB" }])
    } else {
      expect(failure).toBeUndefined()
      expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("ABX")
      expect(events.at(-1)).toMatchObject({ type: "done", text: "ABX" })
    }
  }
})
