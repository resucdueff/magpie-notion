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
const tokens = (value) => internals.tokenCount(value)
const prose = (bytes) => {
  const seed = "The adapter keeps protected instructions, recent conversation and the newest request together while measuring a real local tokenizer window. "
  return seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes)
}
const dense = (length, alphabet) => Array.from({ length }, (_, index) => alphabet[(index * 17 + 11) % alphabet.length]).join("")

function mockNotion(options = {}) {
  const calls = []
  let creates = 0
  let sends = 0
  let committedSequence = 0
  const threadTokens = new Map()
  const answerSize = options.answerSize ?? 0
  const overLimitSends = []
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
      threadTokens.set(data.threadId, tokens(data.content[0].text[0][0]) + internals.TURN_OVERHEAD_TOKENS)
      return Response.json({ threadId: data.threadId })
    }
    if (name === "sendEventToAgentThread") {
      const next = (threadTokens.get(data.threadId) ?? 0) + tokens(data.event.content[0].text[0][0])
      if (next > internals.THREAD_TOKEN_BUDGET) overLimitSends.push(next)
      threadTokens.set(data.threadId, next)
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
      const text = (continued ? "Continued answer" : "First answer") + " detail".repeat(Math.ceil(answerSize / 7)).slice(0, answerSize)
      const prior = threadTokens.get(data.threadId) ?? 0
      const next = prior + tokens(text)
      if (next > internals.THREAD_TOKEN_BUDGET) overLimitSends.push(next)
      threadTokens.set(data.threadId, next)
      return ndjson([frame(answer(text, answerSequence), done(doneSequence))])
    }
    throw new Error("Unexpected offline endpoint " + name)
  })
  return {
    calls,
    threadTokens,
    overLimitSends,
    get creates() { return creates },
    get sends() { return sends },
  }
}

async function request(body) {
  const plugin = createPlugin(protocol)
  const loader = await plugin.auth.loader(async () => auth)
  return loader.fetch("https://notion.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

test("models keep the 40K adapter window local and publish only the 8K output budget", () => {
  expect(internals.CONTEXT_BUDGET).toBe(40_000)
  expect(internals.THREAD_TOKEN_BUDGET).toBe(40_000)
  expect(internals.TURN_OVERHEAD_TOKENS).toBe(256)
  expect(internals.MAX_INPUT_BYTES).toBe(2 * 1024 * 1024)
  expect(internals.OUTPUT_BUDGET).toBe(8192)
  const limit = internals.modelEntry(model).limit
  expect(limit.context).toBeUndefined()
  expect(limit).toEqual({ output: 8192 })
})

test("a 46,831-byte natural-language system prompt is accepted", async () => {
  const mock = mockNotion()
  const system = prose(46_831)
  expect(internals.utf8Bytes(system)).toBe(46_831)
  expect(tokens(system)).toBeLessThan(40_000)
  const response = await request(chat([
    { role: "system", content: system },
    { role: "user", content: "Reply with OK" },
  ]))
  expect(response.status).toBe(200)
  const created = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(created).toContain(system)
  expect(created).toContain("Reply with OK")
  expect(tokens(created)).toBeLessThanOrEqual(40_000)
})

test("a 39.5K cl100k natural-language request reaches upstream despite the host byte estimate", async () => {
  const mock = mockNotion()
  const sentence = "Notwithstanding extraordinarily comprehensive internationalization considerations, the administration conscientiously documented interdisciplinary responsibilities and environmental sustainability outcomes. "
  const tail = " This final sentence confirms the review is complete after all interdisciplinary considerations were documented and communicated to the administration."
  const content = sentence.repeat(1_973) + tail
  expect(tokens(content)).toBe(39_481)
  expect(tokens(content)).toBeLessThan(40_000)
  expect(Math.floor(internals.utf8Bytes(content) / 4)).toBeGreaterThan(100_000)

  const response = await request(chat([{ role: "user", content }]))
  expect(response.status).toBe(200)
  expect(mock.creates).toBe(1)
  const created = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(created).toBe(content)
})

test("a Codex-style system and developer transcript is accepted in the token budget", async () => {
  const mock = mockNotion()
  const system = "SYSTEM-MARKER\n" + prose(23_900)
  const developer = "DEVELOPER-MARKER\n" + prose(22_900)
  const response = await request(chat([
    { role: "system", content: system },
    { role: "developer", content: developer },
    { role: "user", content: "Continue the task" },
  ]))
  expect(response.status).toBe(200)
  const created = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(created).toContain("SYSTEM-MARKER")
  expect(created).toContain("DEVELOPER-MARKER")
  expect(created).toContain("Continue the task")
  expect(tokens(created)).toBeLessThanOrEqual(40_000)
})

test("70K Base64 and 132K hex latest messages are rejected locally before any upstream call", async () => {
  const mock = mockNotion()
  const values = [
    dense(70_000, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),
    dense(132_000, "0123456789abcdef"),
  ]
  for (const content of values) {
    expect(tokens(content)).toBeGreaterThan(40_000)
    const response = await request(chat([{ role: "user", content }]))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe("context_length_exceeded")
    expect(body.error.message).toContain("latest user message")
    expect(body.error.message).toContain("token budget")
    expect(JSON.stringify(body)).not.toContain(content)
  }
  expect(mock.calls).toHaveLength(0)
})

test("44K and 50K ordinary English user text is accepted when its token count fits", async () => {
  const mock = mockNotion()
  for (const length of [44_000, 50_000]) {
    const content = "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(length / 45)).slice(0, length)
    expect(internals.utf8Bytes(content)).toBe(length)
    expect(tokens(content)).toBeLessThan(40_000)
    const response = await request(chat([{ role: "user", content }]))
    expect(response.status).toBe(200)
  }
  expect(mock.creates).toBe(2)
})

test("Chinese and emoji history is counted with the real tokenizer and omitted safely", () => {
  expect(tokens("中文😀")).toBe(4)
  const old = "旧".repeat(60_000)
  const latest = "最新😀".repeat(3_000)
  const plan = internals.contextPlan([
    { role: "system", content: "保留系统指令" },
    { role: "user", content: old },
    { role: "assistant", content: "早期回答" },
    { role: "user", content: latest },
  ])
  expect(plan.fullOverBudget).toBe(true)
  expect(plan.estimated.tokens).toBeLessThanOrEqual(40_000)
  expect(plan.omittedCount).toBeGreaterThan(0)
  expect(plan.text).toContain(latest)
  expect(plan.text).toContain("保留系统指令")
  expect(plan.text).not.toContain(old)
  expect(plan.text).not.toContain("\uFFFD")
})

test("the exact 40,000-token boundary is admitted and 40,001 is rejected", async () => {
  const admitted = " hello".repeat(40_000)
  const rejected = " hello".repeat(40_001)
  expect(tokens(admitted)).toBe(40_000)
  expect(tokens(rejected)).toBe(40_001)
  const plan = internals.contextPlan([{ role: "user", content: admitted }])
  expect(plan.estimated.tokens).toBe(40_000)

  const mock = mockNotion()
  expect((await request(chat([{ role: "user", content: admitted }]))).status).toBe(200)
  const callsBefore = mock.calls.length
  const failure = await request(chat([{ role: "user", content: rejected }]))
  expect(failure.status).toBe(400)
  expect((await failure.json()).error.message).toContain("latest user message")
  expect(mock.calls).toHaveLength(callsBefore)
})

test("protected, latest and combined context failures are attributed separately before upstream", async () => {
  const mock = mockNotion()
  const cases = [
    {
      messages: [
        { role: "system", content: " hello".repeat(40_001) },
        { role: "user", content: "latest" },
      ],
      phrase: "protected system/developer instructions",
    },
    {
      messages: [{ role: "user", content: " hello".repeat(40_001) }],
      phrase: "latest user message",
    },
    {
      messages: [
        { role: "system", content: " hello".repeat(25_000) },
        { role: "user", content: " hello".repeat(25_000) },
      ],
      phrase: "together",
    },
  ]
  for (const item of cases) {
    const response = await request(chat(item.messages))
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe("context_length_exceeded")
    expect(body.error.message).toContain(item.phrase)
    expect(body.error.message).toContain("token budget")
    expect(body.error.message).not.toContain("UTF-8 bytes")
  }
  expect(mock.calls).toHaveLength(0)
})

test("cumulative sentTokens admits the exact token boundary and rolls over above it", () => {
  const incoming = " hello".repeat(1_000)
  expect(tokens(incoming)).toBe(1_000)
  const admittedAt = internals.THREAD_TOKEN_BUDGET - tokens(incoming)
  expect(internals.threadTurnTokens(admittedAt, incoming)).toBe(internals.THREAD_TOKEN_BUDGET)
  expect(internals.threadTurnTokens(admittedAt + 1, incoming)).toBeUndefined()
  expect(internals.threadTurnTokens(undefined, incoming)).toBeUndefined()
})

test("six bounded rounds accumulate sentTokens and roll over without an oversized send", async () => {
  const mock = mockNotion()
  const system = { role: "system", content: "PINNED-SYSTEM" }
  const ancient = { role: "user", content: "old question" }
  const hugeOldAnswer = { role: "assistant", content: " old".repeat(50_000) }
  let history = [system, ancient, hugeOldAnswer, { role: "user", content: "Start" }]
  let response = await request(chat(history))
  let body = await response.json()
  expect(response.status).toBe(200)
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(0)
  expect(internals.contextPlan(history).fullOverBudget).toBe(true)

  const outcomes = []
  const createdPrefixes = []
  for (let round = 0; round < 5; round++) {
    history = [
      ...history,
      body.choices[0].message,
      { role: "user", content: `turn-${round}\n` + " x".repeat(8_400) },
    ]
    const createsBefore = mock.creates
    const sendsBefore = mock.sends
    response = await request(chat(history))
    body = await response.json()
    expect(response.status).toBe(200)
    if (mock.creates > createsBefore) {
      expect(mock.sends).toBe(sendsBefore)
      outcomes.push("create")
      createdPrefixes.push(mock.calls.filter((call) => call.name === "createAgentThread").at(-1).data.content[0].text[0][0])
    } else {
      expect(mock.sends).toBe(sendsBefore + 1)
      outcomes.push("send")
    }
  }
  expect(outcomes).toContain("send")
  expect(outcomes.at(-1)).toBe("create")
  expect(outcomes.length).toBe(5)
  expect(mock.overLimitSends).toEqual([])
  for (const text of createdPrefixes) {
    expect(tokens(text)).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
    expect(text).toContain("PINNED-SYSTEM")
  }
})

test("a full-history turn rebuilds a bounded thread and then continues it", async () => {
  const mock = mockNotion()
  const history = []
  for (let index = 0; index < 14; index++) {
    history.push({ role: "user", content: `ROUND-${index}-` + " u".repeat(3_200) })
    history.push({ role: "assistant", content: `ANSWER-${index}-` + " a".repeat(3_200) })
  }
  const latest = { role: "user", content: "Latest question remains intact" }
  expect(internals.contextPlan([...history, latest]).fullOverBudget).toBe(true)
  const first = await request(chat([...history, latest]))
  const firstBody = await first.json()
  expect(first.status).toBe(200)
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(0)
  const firstCreated = mock.calls.find((call) => call.name === "createAgentThread").data.content[0].text[0][0]
  expect(tokens(firstCreated)).toBeLessThanOrEqual(internals.CONTEXT_BUDGET)
  expect(firstCreated).toContain("Latest question remains intact")
  expect(firstCreated).toContain("[Earlier history omitted /")

  const assistant = firstBody.choices[0].message
  const second = await request(chat([...history, latest, assistant, { role: "user", content: "Next question" }]))
  expect(second.status).toBe(200)
  expect((await second.json()).choices[0].message.content).toBe("Continued answer")
  expect(mock.creates).toBe(1)
  expect(mock.sends).toBe(1)
})

test("a large but bounded rollover keeps continuing on following rounds", async () => {
  const mock = mockNotion()
  const base = []
  for (let index = 0; index < 14; index++) {
    base.push({ role: "user", content: `ROUND-${index}-` + " u".repeat(3_200) })
    base.push({ role: "assistant", content: `ANSWER-${index}-` + " a".repeat(3_200) })
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

test("a cache record without cumulative token accounting is never continued", async () => {
  const mock = mockNotion()
  const initial = await firstTurn()
  for (const value of internals.sessions.values()) delete value.sentTokens
  const response = await request(chat([...initial, { role: "user", content: "Second" }]))
  expect(response.status).toBe(200)
  expect(mock.sends).toBe(0)
  expect(mock.creates).toBe(2)
  expect(internals.sessions.size).toBe(1)
})

test("an oversized latest user neither calls upstream nor consumes a cached continuation", async () => {
  const mock = mockNotion()
  const initial = await firstTurn()
  expect(internals.sessions.size).toBe(1)
  const callsBefore = mock.calls.length
  const oversized = dense(70_000, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

  const rejected = await request(chat([...initial, { role: "user", content: oversized }]))
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
  const toolData = "TOOL-RESULT-" + " t".repeat(100_000) + "-END"
  expect(tokens(toolData)).toBeGreaterThan(40_000)
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
  expect(tokens(created)).toBeLessThanOrEqual(40_000)
})

test("the 2 MB transport ceiling rejects an otherwise untokenizable request before upstream", async () => {
  const mock = mockNotion()
  const response = await request(chat([{ role: "user", content: "x".repeat(internals.MAX_INPUT_BYTES + 1) }]))
  expect(response.status).toBe(413)
  const body = await response.json()
  expect(body.error.code).toBe("request_too_large")
  expect(body.error.message).toContain("2 MB")
  expect(mock.calls).toHaveLength(0)
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
