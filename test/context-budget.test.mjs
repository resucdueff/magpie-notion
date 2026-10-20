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
  let committedSequence = 0
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
      return Response.json(page([], committedSequence, committedSequence ? "idle" : "running"))
    }
    if (name === "listenToThreadTranscript") {
      const continued = sends > 0
      const answerSequence = committedSequence + 1
      const doneSequence = committedSequence + 2
      committedSequence = doneSequence
      return ndjson([frame(answer(continued ? "Continued answer" : "First answer", answerSequence), done(doneSequence))])
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
  expect(internals.CONTEXT_BYTE_BUDGET).toBe(44_000)
  expect(internals.OUTPUT_BUDGET).toBe(8192)
  expect(internals.modelEntry(model).limit).toEqual({ context: 44_000, output: 8192 })
})

test("UTF-8 bytes are the send gate, so 50K and 250K latest messages are rejected before upstream", async () => {
  const mock = mockNotion()
  for (const content of ["a".repeat(50_000), "b".repeat(250_000)]) {
    const rejected = await request(chat([{ role: "user", content }]))
    const body = await rejected.json()
    expect(rejected.status).toBe(400)
    expect(body.error.code).toBe("context_length_exceeded")
    expect(body.error.message).toContain("latest user message")
    expect(JSON.stringify(body)).not.toContain(content)
  }
  expect(mock.calls).toHaveLength(0)
})

test("dense 70K and 132K ASCII/Base64 latest messages never reach upstream oversized", async () => {
  const mock = mockNotion()
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const base64 = Array.from({ length: 70_000 }, (_, index) => alphabet[(index * 17 + 11) % alphabet.length]).join("")
  const hexPattern = "0123456789abcdef"
  const hex = hexPattern.repeat(Math.ceil(132_000 / hexPattern.length)).slice(0, 132_000)

  for (const content of [base64, hex]) {
    const callsBefore = mock.calls.length
    const response = await request(chat([{ role: "user", content }]))
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain("latest user message")
    expect(mock.calls).toHaveLength(callsBefore)
  }
  expect(mock.creates).toBe(0)
})

test("dense JSON history is bounded by bytes even when the token estimate is much smaller", () => {
  const json = "{\"key\":\"0123456789abcdef\",\"value\":\"ABCDEFGHIJKLMNOPQRSTUVWXYZ\"},"
  const dense = json.repeat(Math.ceil(132_000 / json.length)).slice(0, 132_000)
  const plan = internals.contextPlan([
    { role: "system", content: "Keep this instruction" },
    { role: "user", content: dense },
    { role: "assistant", content: "ack" },
    { role: "user", content: "latest" },
  ])
  expect(internals.estimateTokens(dense)).toBeLessThan(50_000)
  expect(internals.utf8Bytes(dense)).toBeGreaterThan(132_000 - 200)
  expect(plan.estimated.bytes).toBeLessThanOrEqual(internals.CONTEXT_BYTE_BUDGET)
  expect(plan.text).toContain("Keep this instruction")
  expect(plan.text).toContain("latest")
  expect(plan.text).not.toContain(dense)
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
  expect(plan.estimated.bytes).toBeLessThanOrEqual(internals.CONTEXT_BYTE_BUDGET)
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
  const latest = "最新😀".repeat(3_000)
  const plan = internals.contextPlan([
    { role: "system", content: "保留系统指令" },
    { role: "user", content: old },
    { role: "assistant", content: "早期回答" },
    { role: "user", content: latest },
  ])
  expect(plan.estimated.bytes).toBeLessThanOrEqual(internals.CONTEXT_BYTE_BUDGET)
  expect(plan.omittedCount).toBeGreaterThan(0)
  expect(plan.text).toContain(latest)
  expect(plan.text).toContain("保留系统指令")
  expect(plan.text).not.toContain(old)
  expect(plan.text).not.toContain("\uFFFD")
})

test("oversized system instructions have a distinct protected-budget error", () => {
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
  expect(failure.message).toContain("protected system/developer instructions")
  expect(failure.message).not.toContain("tool results")
})

test("a full-over-budget bounded thread is continued on the next full-history turn", async () => {
  const mock = mockNotion({ continueThread: true })
  const history = []
  for (let index = 0; index < 14; index++) {
    history.push({ role: "user", content: `ROUND-${index}-` + "u".repeat(3_200) })
    history.push({ role: "assistant", content: `ANSWER-${index}-` + "a".repeat(3_200) })
  }
  const latest = { role: "user", content: "Latest question remains intact" }
  const full = internals.contextPlan([...history, latest]).full
  expect(full.bytes).toBeGreaterThan(internals.CONTEXT_BYTE_BUDGET)
  const first = await request(chat([...history, latest]))
  const firstBody = await first.json()
  expect(first.status).toBe(200)
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(0)
  const firstCreated = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(internals.utf8Bytes(firstCreated)).toBeLessThanOrEqual(internals.CONTEXT_BYTE_BUDGET)
  expect(firstCreated).toContain("Latest question remains intact")
  expect(firstCreated).toContain("[Earlier history omitted /")

  const assistant = firstBody.choices[0].message
  const second = await request(chat([...history, latest, assistant, { role: "user", content: "Next question" }]))
  expect(second.status).toBe(200)
  expect((await second.json()).choices[0].message.content).toBe("Continued answer")
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
  expect(internals.contextPlan([...history, latest, assistant, { role: "user", content: "Next question" }]).fullOverBudget).toBe(true)
  expect(mock.calls.find((call) => call.name === "sendEventToAgentThread").data.event.content[0].text).toEqual([["Next question"]])
})

test("a large but bounded rollover continues instead of recreating on the following rounds", async () => {
  const mock = mockNotion({ continueThread: true })
  const base = []
  for (let index = 0; index < 14; index++) {
    base.push({ role: "user", content: `ROUND-${index}-` + "u".repeat(3_200) })
    base.push({ role: "assistant", content: `ANSWER-${index}-` + "a".repeat(3_200) })
  }
  const latest = { role: "user", content: "Latest question" }
  let response = await request(chat([...base, latest]))
  let body = await response.json()
  expect(response.status).toBe(200)
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(0)

  let history = [...base, latest]
  for (let round = 0; round < 3; round++) {
    const createsBefore = mock.creates
    const sendsBefore = mock.sends
    history = [...history, body.choices[0].message, { role: "user", content: `Follow-up ${round}` }]
    response = await request(chat(history))
    body = await response.json()
    expect(response.status).toBe(200)
    expect(body.choices[0].message.content).toBe("Continued answer")
    expect(mock.creates).toBe(createsBefore)
    expect(mock.sends).toBe(sendsBefore + 1)
  }
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
  expect(internals.utf8Bytes(created)).toBeLessThanOrEqual(internals.CONTEXT_BYTE_BUDGET)
})

test.each([
  ["maximum context length exceeded", "context_length_exceeded"],
  ["context window is full", "context_length_exceeded"],
  ["too many tokens in prompt", "context_length_exceeded"],
  ["personal agent rejected this request", "notion_request_rejected"],
  ["field length exceeds its maximum", "notion_request_rejected"],
  ["maximum size is 12", "notion_request_rejected"],
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
      ? Response.json({ error: "context length exceeded" }, { status: 400 })
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
