import { test, expect, beforeEach, afterEach } from "bun:test"
import { createPlugin } from "../core.mjs"
import protocol, { _internal as internals } from "../protocol.mjs"

const uuid = "11111111-1111-4111-8111-111111111111"
const token = "{{SECRET_context_budget}}"
const auth = { type: "api", key: token, metadata: { spaceId: uuid } }
const model = {
  model: "test-model",
  modelMessage: "Offline context test",
  agentService: {},
  modelConfiguration: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" },
}
const chat = (messages) => ({ model: model.model, messages })
const answer = (text, sequence = 1) => ({ op: "put", entity: { id: "assistant", kind: "assistant_message", sequence, content: [{ type: "text", text }] } })
const done = (sequence = 2) => ({ op: "put", entity: { id: "done", kind: "turn_completed", sequence, stop_reason: "end_turn" } })
const frame = (...patches) => ({ type: "agent_service_transcript_delta", patches })
const page = (patches = [], sequence = 0, status = "running") => ({
  type: "agent_service_transcript_page",
  patches,
  session: { sequence, status },
  forward_cursor: "offline-cursor",
})
const ndjson = (frames) => new Response(frames.map((value) => JSON.stringify(value)).join("\n") + "\n")

function mockNotion(options = {}) {
  const calls = []
  let creates = 0
  let sends = 0
  internals.useFetch(async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    const data = JSON.parse(init.body)
    calls.push({ name, data, init, url: String(url) })
    if (options.handle) {
      const custom = await options.handle(name, data, calls)
      if (custom) return custom
    }
    if (name === "authValidate") return Response.json({})
    if (name === "getAvailableModels") return Response.json({ models: [model] })
    if (name === "createAgentThread") {
      creates++
      return Response.json({ threadId: data.threadId })
    }
    if (name === "sendEventToAgentThread") {
      sends++
      return Response.json({})
    }
    if (name === "getThreadTranscript") {
      const reads = calls.filter((call) => call.name === "getThreadTranscript").length
      if (options.continueThread && reads === 2 && sends === 0) return Response.json(page([], 2, "idle"))
      return Response.json(page([], sends ? 4 : 0, sends ? "idle" : "running"))
    }
    if (name === "listenToThreadTranscript") {
      return ndjson([frame(answer(sends ? "Continued answer" : "First answer", sends ? 3 : 1), done(sends ? 4 : 2))])
    }
    throw new Error("Unexpected offline endpoint " + name)
  })
  return { calls, get creates() { return creates }, get sends() { return sends } }
}

async function request(body) {
  const plugin = createPlugin(protocol)
  const loader = await plugin.auth.loader(async () => auth)
  return loader.fetch("https://notion.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
}

async function firstTurn(text = "First") {
  const result = await (await request(chat([{ role: "user", content: text }]))).json()
  expect(result.choices[0].message.content).toBe("First answer")
  return [
    { role: "user", content: text },
    { role: "assistant", content: result.choices[0].message.content },
  ]
}

beforeEach(() => {
  internals.sessions.clear()
  internals.catalogs.clear()
  internals.resolved.clear()
})

afterEach(() => {
  internals.useFetch(undefined)
})

test("models publish the conservative adapter context and output windows", () => {
  expect(internals.CONTEXT_BUDGET).toBe(44_000)
  expect(internals.OUTPUT_BUDGET).toBe(8192)
  expect(internals.modelEntry(model).limit).toEqual({ context: 44_000, output: 8192 })
})

test("50K ASCII fits while a 250K latest user is rejected before any upstream call", async () => {
  const mock = mockNotion()
  const fitting = "a".repeat(50_000)
  const ok = await request(chat([{ role: "user", content: fitting }]))
  expect(ok.status).toBe(200)
  expect((await ok.json()).choices[0].message.content).toBe("First answer")
  expect(internals.estimateTokens(fitting)).toBeLessThan(internals.CONTEXT_BUDGET)
  expect(mock.creates).toBe(1)

  const callsBefore = mock.calls.length
  const oversized = "b".repeat(250_000)
  const rejected = await request(chat([{ role: "user", content: oversized }]))
  const body = await rejected.json()
  expect(rejected.status).toBe(400)
  expect(body.error.code).toBe("context_length_exceeded")
  expect(body.error.message).toContain("Compress earlier tool results")
  expect(mock.calls).toHaveLength(callsBefore)
  expect(JSON.stringify(body)).not.toContain(oversized)
})

test("a bounded plan preserves all instructions and the complete latest user message", () => {
  const system = { role: "system", content: "SYSTEM-" + "s".repeat(10_000) }
  const developer = { role: "developer", content: "DEVELOPER-" + "d".repeat(10_000) }
  const history = []
  for (let index = 0; index < 14; index++) {
    history.push({ role: "user", content: `U${index}-` + "u".repeat(10_000) })
    history.push({ role: "assistant", content: `A${index}-` + "a".repeat(10_000) })
  }
  const latest = { role: "user", content: "LATEST-" + "l".repeat(15_000) }
  const messages = [system, developer, ...history, latest]
  const plan = internals.contextPlan(messages)

  expect(plan.fullOverBudget).toBe(true)
  expect(plan.omittedCount).toBeGreaterThan(0)
  expect(plan.estimated.tokens).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
  expect(plan.text).toContain(system.content)
  expect(plan.text).toContain(developer.content)
  expect(plan.text).toContain(latest.content)
  expect(plan.text).toContain("[Earlier history omitted /")
  expect(plan.text).toContain(`${plan.omittedCount} earlier messages`)
  expect(plan.omittedTokens).toBeGreaterThan(0)
  expect(plan.omittedBytes).toBeGreaterThan(0)
  expect(plan.messages).toContain(system)
  expect(plan.messages).toContain(developer)
  expect(plan.messages).toContain(latest)
  expect(plan.messages.every((message) => messages.includes(message))).toBe(true)
})

test("UTF-8 byte estimation and bounded selection are safe for Chinese and emoji", () => {
  expect(internals.estimateTokens("中文😀")).toBe(4)
  const old = "中".repeat(60_000)
  const latest = "最新😀".repeat(10_000)
  const plan = internals.contextPlan([
    { role: "system", content: "保留系统指令" },
    { role: "user", content: old },
    { role: "assistant", content: "早期回答" },
    { role: "user", content: latest },
  ])
  expect(internals.estimateTokens(latest)).toBeLessThan(internals.CONTEXT_BUDGET)
  expect(plan.omittedCount).toBeGreaterThan(0)
  expect(plan.text).toContain(latest)
  expect(plan.text).toContain("保留系统指令")
  expect(plan.text).not.toContain(old)
  expect(plan.text).not.toContain("\uFFFD")
})

test("protected instructions plus the omission marker cannot exceed the budget", () => {
  const messages = [
    { role: "system", content: "s".repeat(132_000) },
    { role: "assistant", content: "an old answer" },
    { role: "user", content: "latest" },
  ]
  let failure
  try {
    internals.contextPlan(messages)
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ status: 400, code: "context_length_exceeded" })
  expect(failure.message).toContain("start a new conversation")
})

test("a 51K-equivalent 14-round history creates a bounded thread and the next turn rolls over", async () => {
  const mock = mockNotion()
  const history = []
  for (let index = 0; index < 14; index++) {
    history.push({ role: "user", content: `ROUND-${index}-` + "u".repeat(5_450) })
    history.push({ role: "assistant", content: `ANSWER-${index}-` + "a".repeat(5_450) })
  }
  const latest = { role: "user", content: "Latest question remains intact" }
  const full = internals.contextPlan([...history, latest]).full
  expect(full.tokens).toBeGreaterThan(50_000)
  expect(full.tokens).toBeLessThan(52_000)
  const first = await request(chat([...history, latest]))
  const firstBody = await first.json()
  expect(first.status).toBe(200)
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(0)
  const firstCreated = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(internals.estimateTokens(firstCreated)).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
  expect(firstCreated).toContain("Latest question remains intact")
  expect(firstCreated).toContain("[Earlier history omitted /")

  const assistant = firstBody.choices[0].message
  const second = await request(chat([...history, latest, assistant, { role: "user", content: "Next question" }]))
  expect(second.status).toBe(200)
  expect(mock.creates).toBe(2)
  expect(mock.sends).toBe(0)
  const created = mock.calls.filter((call) => call.name === "createAgentThread")
  const secondCreated = created.at(-1).data.content[0].text[0][0]
  expect(internals.estimateTokens(secondCreated)).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
  expect(secondCreated).toContain("Next question")
  expect(created[0].data.threadId).not.toBe(created[1].data.threadId)
})

test("an oversized latest user neither calls upstream nor consumes a cached continuation", async () => {
  const mock = mockNotion({ continueThread: true })
  const initial = await firstTurn()
  expect(internals.sessions.size).toBe(1)
  const callsBefore = mock.calls.length

  const rejected = await request(chat([...initial, { role: "user", content: "x".repeat(250_000) }]))
  expect(rejected.status).toBe(400)
  expect((await rejected.json()).error.code).toBe("context_length_exceeded")
  expect(mock.calls).toHaveLength(callsBefore)
  expect(internals.sessions.size).toBe(1)

  const retried = await request(chat([...initial, { role: "user", content: "Second" }]))
  expect(retried.status).toBe(200)
  expect((await retried.json()).choices[0].message.content).toBe("Continued answer")
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
})

test("a large historical tool result is omitted while the latest user is retained", async () => {
  const mock = mockNotion()
  const toolData = "TOOL-RESULT-" + "t".repeat(250_000) + "-END"
  const latest = "Use the summary, not the raw tool output"
  const response = await request(chat([
    { role: "user", content: "Run the tool" },
    { role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "shell", arguments: "{\"cmd\":\"inspect\"}" } }] },
    { role: "tool", name: "shell", content: toolData },
    { role: "user", content: latest },
  ]))
  expect(response.status).toBe(200)
  const created = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(created).toContain(latest)
  expect(created).not.toContain("TOOL-RESULT-")
  expect(created).toContain("[Earlier history omitted /")
  expect(internals.estimateTokens(created)).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
})

test.each([
  ["maximum context length exceeded", "context_length_exceeded"],
  ["personal agent rejected this request", "notion_request_rejected"],
])("thread creation HTTP 400 is classified locally without exposing its body: %s", async (message, code) => {
  const mock = mockNotion({
    handle: (name) => name === "createAgentThread"
      ? Response.json({ message, private_diagnostic: "upstream-private-account-data" }, { status: 400 })
      : undefined,
  })
  const response = await request(chat([{ role: "user", content: "Hello" }]))
  const body = await response.text()
  expect(response.status).toBe(400)
  expect(body).toContain(code)
  expect(body).not.toContain("upstream-private-account-data")
  expect(mock.creates).toBe(0)
})

test("a continuation HTTP 400 is classified and leaves the cached history retryable", async () => {
  const mock = mockNotion({
    continueThread: true,
    handle: (name) => name === "sendEventToAgentThread"
      ? Response.json({ error: "request size exceeds the maximum" }, { status: 400 })
      : undefined,
  })
  const initial = await firstTurn()
  const response = await request(chat([...initial, { role: "user", content: "Second" }]))
  const body = await response.text()
  expect(response.status).toBe(400)
  expect(body).toContain("context_length_exceeded")
  expect(internals.sessions.size).toBe(1)
  expect(mock.sends).toBe(0)
})
