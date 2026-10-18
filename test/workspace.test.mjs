import { afterEach, beforeEach, expect, test } from "bun:test"
import { createPlugin } from "../core.mjs"
import protocol, { _internal as internals } from "../protocol.mjs"

const SPACE = "231546b1-eb2d-8176-a5ab-00035eb5210c"
const OTHER = "e86cfd18-5a19-4b6c-9a71-0c9f9e6d1b42"
const USER = "22222222-2222-4222-8222-222222222222"
const THREAD = "33333333-3333-4333-8333-333333333333"
// A sign-in that states no workspace: the workspace is discovered from token_v2.
const auth = { type: "api", key: "token_v2=offline-session" }
const model = { model: "test-model", modelMessage: "Test", agentService: {}, modelConfiguration: { supportedReasoningEfforts: ["low"] } }
const chat = { model: model.model, messages: [{ role: "user", content: "Hello" }] }
const spaces = (ids = [OTHER, SPACE], user = USER) => ({ [user]: { notion_user: { [user]: { value: { email: "person@example.com" } } }, space: Object.fromEntries(ids.map((id) => [id, { value: { name: "Workspace" } }])) } })
const frame = (...patches) => ({ type: "agent_service_transcript_delta", patches })
const answer = (sequence) => ({ op: "put", entity: { id: "assistant", kind: "assistant_message", sequence, content: [{ type: "text", text: "Answer" }] } })
const completed = (sequence) => ({ op: "put", entity: { id: "done", kind: "turn_completed", sequence, stop_reason: "end_turn" } })
const ndjson = (frames) => new Response(frames.map((value) => JSON.stringify(value)).join("\n") + "\n")
const cookieValue = (header, name) => header.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1)

function mockNotion(options = {}) {
  const calls = []
  internals.useFetch(async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    calls.push({ name, data: JSON.parse(init.body), headers: init.headers })
    const custom = await options.handle?.(name, calls.at(-1))
    if (custom) return custom
    if (name === "getSpaces") return Response.json(options.spaces ?? spaces())
    if (name === "getAvailableModels") {
      const answerable = options.answerable ?? [SPACE]
      if (!answerable.includes(calls.at(-1).data.spaceId)) return new Response(null, { status: 403 })
      return Response.json({ models: [model] })
    }
    if (name === "authValidate") return Response.json({})
    if (name === "createAgentThread") return Response.json({ threadId: THREAD })
    if (name === "getThreadTranscript") return Response.json({ type: "agent_service_transcript_page", patches: [], session: { sequence: 0, status: "running" }, forward_cursor: "cursor" })
    if (name === "listenToThreadTranscript") return ndjson([frame(answer(1), completed(2))])
    if (name === "getCreditRateLimitStatus") return Response.json({ status: "not_applicable" })
    if (name === "getAIUsageEligibilityV2") return Response.json({})
    throw new Error("Unexpected offline endpoint " + name)
  })
  return { calls, names: () => calls.map((call) => call.name) }
}

async function asked(signal) {
  const events = []
  for await (const event of await protocol.open({ auth, chat, signal })) events.push(event)
  return events
}

beforeEach(() => { internals.resolved.clear(); internals.catalogs.clear(); internals.sessions.clear() })
afterEach(() => { internals.useFetch(undefined) })

test("a session that names no workspace finds the one its models answer for", async () => {
  const mock = mockNotion()
  const events = await asked(AbortSignal.timeout(5_000))
  expect(events.at(-1)).toMatchObject({ type: "done" })
  // The candidates come from getSpaces, in its order: the one that refused is
  // not the account's workspace, so the next one is asked, and the answer that
  // named the workspace is the catalog instead of an extra question.
  const probes = mock.calls.filter((call) => call.name === "getAvailableModels")
  expect(probes[0].data.spaceId).toBe(OTHER)
  expect(probes.slice(1).every((call) => call.data.spaceId === SPACE)).toBe(true)
  expect(probes.map((call) => call.headers["x-notion-space-id"])).toEqual(probes.map((call) => call.data.spaceId))
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-space-id"]).toBe(SPACE)
})

test("the workspace is remembered, so later requests do not ask again", async () => {
  const mock = mockNotion()
  await asked(AbortSignal.timeout(5_000))
  await asked(AbortSignal.timeout(5_000))
  expect(mock.names().filter((name) => name === "getSpaces")).toHaveLength(1)
  expect(internals.resolved.size).toBe(1)
  expect([...internals.resolved.values()][0]).toMatchObject({ spaceId: SPACE, activeUserId: USER })
})

test("a remembered workspace is dropped when it has aged out", async () => {
  const mock = mockNotion()
  await asked(AbortSignal.timeout(5_000))
  for (const entry of internals.resolved.values()) entry.at = Date.now() - internals.RESOLVED_TTL - 1
  await asked(AbortSignal.timeout(5_000))
  expect(mock.names().filter((name) => name === "getSpaces")).toHaveLength(2)
})

test("another session is discovered on its own, never from the first one's answer", async () => {
  const mock = mockNotion()
  await asked(AbortSignal.timeout(5_000))
  for await (const event of await protocol.open({ auth: { type: "api", key: "token_v2=someone-else" }, chat, signal: AbortSignal.timeout(5_000) })) void event
  expect(mock.names().filter((name) => name === "getSpaces")).toHaveLength(2)
  expect(internals.resolved.size).toBe(2)
})

test("the user the session names is sent as the active user", async () => {
  const mock = mockNotion()
  await asked(AbortSignal.timeout(5_000))
  expect(mock.calls.filter((call) => call.name !== "getSpaces").every((call) => call.headers["x-notion-active-user-header"] === USER)).toBe(true)
})

test("the create request uses Chrome web headers and a normalized Cookie", async () => {
  const mock = mockNotion()
  const stated = { type: "api", key: "token_v2=" + "fake-token-v2" + "; notion_user_id=" + USER, metadata: { activeUserId: USER } }
  for await (const event of await protocol.open({ auth: stated, chat, signal: AbortSignal.timeout(5_000) })) void event
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  const listen = mock.calls.find((call) => call.name === "listenToThreadTranscript")
  // The explicit fetch override observes creation too; impit is not imported.
  expect(mock.names().filter((name) => name === "createAgentThread")).toHaveLength(1)
  expect(created.headers.Accept).toBe("application/json")
  expect(listen.headers.Accept).toBe("application/x-ndjson")
  expect(created.headers["notion-audit-log-platform"]).toBe("web")
  expect(created.headers["Sec-Fetch-Site"]).toBe("same-origin")
  expect(cookieValue(created.headers.Cookie, "token_v2")).toBe("fake-token-v2")
  expect(cookieValue(created.headers.Cookie, "device_id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(cookieValue(created.headers.Cookie, "notion_users")).toBe(encodeURIComponent(JSON.stringify([USER])))
  expect(new Set(mock.calls.map((call) => cookieValue(call.headers.Cookie, "device_id"))).size).toBe(1)
})

test("a workspace is never paired with a user from another getSpaces entry", async () => {
  const other = "44444444-4444-4444-8444-444444444444"
  // The first entry is another signed-in user; the workspace that answers the
  // catalog belongs to the second entry's user.
  const mock = mockNotion({
    spaces: {
      [other]: { notion_user: { [other]: {} }, space: { [OTHER]: {} } },
      [USER]: { notion_user: { [USER]: {} }, space: { [SPACE]: {} } },
    },
    answerable: [SPACE],
  })
  await asked(AbortSignal.timeout(5_000))
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-active-user-header"]).toBe(USER)
  // Each catalog probe names the user of the entry that lists the workspace it
  // asks about, never a user taken from another entry.
  const probes = mock.calls.filter((call) => call.name === "getAvailableModels")
  expect(probes.find((call) => call.data.spaceId === OTHER).headers["x-notion-active-user-header"]).toBe(other)
  expect(probes.find((call) => call.data.spaceId === SPACE).headers["x-notion-active-user-header"]).toBe(USER)
})

test("the user of a workspace is the entry's own user, not another member listed beside it", async () => {
  const member = "44444444-4444-4444-8444-444444444444"
  // The entry belongs to USER and lists a second member in notion_user; the
  // entry key, not the table's first entry, is the account that owns it.
  const mock = mockNotion({
    spaces: { [USER]: { notion_user: { [member]: {}, [USER]: {} }, space: { [SPACE]: {} } } },
  })
  await asked(AbortSignal.timeout(5_000))
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-active-user-header"]).toBe(USER)
})

test("a non-UUID entry with exactly one listed user uses that user", async () => {
  const owner = "44444444-4444-4444-8444-444444444444"
  const mock = mockNotion({
    spaces: { "legacy-entry": { notion_user: { [owner]: {} }, space: { [SPACE]: {} } } },
  })
  await asked(AbortSignal.timeout(5_000))
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-active-user-header"]).toBe(owner)
})

test("a non-UUID entry with several listed users does not guess", async () => {
  const first = "44444444-4444-4444-8444-444444444444"
  const second = "55555555-5555-4555-8555-555555555555"
  const mock = mockNotion({
    spaces: { "legacy-entry": { notion_user: { [first]: {}, [second]: {} }, space: { [SPACE]: {} } } },
  })
  await asked(AbortSignal.timeout(5_000))
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-active-user-header"]).toBeUndefined()
  const probes = mock.calls.filter((call) => call.name === "getAvailableModels")
  expect(probes.every((call) => call.headers["x-notion-active-user-header"] === undefined)).toBe(true)
})

test("a user the sign-in states is sent as stated", async () => {
  const entryUser = "44444444-4444-4444-8444-444444444444"
  const mock = mockNotion({ spaces: { [entryUser]: { notion_user: { [entryUser]: {} }, space: { [SPACE]: {} } } } })
  const stated = { type: "api", key: auth.key, metadata: { activeUserId: USER } }
  for await (const event of await protocol.open({ auth: stated, chat, signal: AbortSignal.timeout(5_000) })) void event
  const created = mock.calls.find((call) => call.name === "createAgentThread")
  expect(created.data.spaceId).toBe(SPACE)
  expect(created.headers["x-notion-active-user-header"]).toBe(USER)
})

test("a cached workspace is kept apart by the user it was resolved for", async () => {
  const other = "44444444-4444-4444-8444-444444444444"
  const mock = mockNotion({
    spaces: { [USER]: { notion_user: { [USER]: {} }, space: { [SPACE]: {} } } },
  })
  await asked(AbortSignal.timeout(5_000))
  for await (const event of await protocol.open({ auth: { type: "api", key: auth.key, metadata: { activeUserId: other } }, chat, signal: AbortSignal.timeout(5_000) })) void event
  // The second request states another user, so the first answer cannot be
  // reused: it was resolved for a different active user.
  expect(mock.names().filter((name) => name === "getSpaces")).toHaveLength(2)
  expect(mock.calls.filter((call) => call.name === "createAgentThread").at(-1).headers["x-notion-active-user-header"]).toBe(other)
  expect(internals.resolved.size).toBe(2)
})

test("a workspace the account states is used as is, without asking Notion which one", async () => {
  const mock = mockNotion({ answerable: [OTHER] })
  const stated = { type: "api", key: auth.key, metadata: { spaceId: OTHER, activeUserId: USER } }
  for await (const event of await protocol.open({ auth: stated, chat, signal: AbortSignal.timeout(5_000) })) void event
  expect(mock.names()).not.toContain("getSpaces")
  expect(mock.calls.find((call) => call.name === "createAgentThread").data.spaceId).toBe(OTHER)
})

test("every workspace refusing is reported with Notion's own status, not an empty account", async () => {
  mockNotion({ answerable: [] })
  const error = await asked(AbortSignal.timeout(5_000)).catch((failure) => failure)
  expect(error).toMatchObject({ status: 403, code: "workspace_forbidden" })
})

test("a later workspace with models wins over an earlier empty catalog", async () => {
  const mock = mockNotion({
    spaces: spaces([OTHER, SPACE]),
    handle: (name, call) => name === "getAvailableModels" && call.data.spaceId === OTHER ? Response.json({ models: [] }) : undefined,
  })
  for await (const event of await protocol.open({ auth, chat, signal: AbortSignal.timeout(5_000) })) void event
  expect(mock.calls.find((call) => call.name === "createAgentThread").data.spaceId).toBe(SPACE)
  expect([...internals.resolved.values()][0]).toMatchObject({ spaceId: SPACE, activeUserId: USER })
})

test("a damaged catalog is skipped in favor of the next readable workspace", async () => {
  const mock = mockNotion({
    spaces: spaces([OTHER, SPACE]),
    handle: (name, call) => name === "getAvailableModels" && call.data.spaceId === OTHER ? new Response("not-json") : undefined,
  })
  for await (const event of await protocol.open({ auth, chat, signal: AbortSignal.timeout(5_000) })) void event
  expect(mock.calls.find((call) => call.name === "createAgentThread").data.spaceId).toBe(SPACE)
  expect([...internals.resolved.values()][0]).toMatchObject({ spaceId: SPACE, activeUserId: USER })
})

test("when every readable workspace is empty, the first one supplies an empty catalog", async () => {
  const mock = mockNotion({
    spaces: spaces([OTHER, SPACE]),
    handle: (name) => name === "getAvailableModels" ? Response.json({ models: [] }) : undefined,
  })
  expect(await protocol.models({ auth })).toEqual({})
  expect([...internals.resolved.values()][0]).toMatchObject({ spaceId: OTHER, activeUserId: USER })
  expect(mock.calls.filter((call) => call.name === "getAvailableModels").map((call) => call.data.spaceId)).toEqual([OTHER, SPACE, OTHER])
})

test("a session in no workspace at all is a clear error before any model call", async () => {
  const mock = mockNotion({ spaces: { [USER]: { notion_user: { [USER]: {} }, space: {} } } })
  const error = await asked(AbortSignal.timeout(5_000)).catch((failure) => failure)
  expect(error).toMatchObject({ status: 404, code: "workspace_not_found" })
  expect(mock.names()).toEqual(["getSpaces"])
})

test("getSpaces failing does not become a guessed workspace", async () => {
  const mock = mockNotion({ handle: (name) => name === "getSpaces" ? new Response(null, { status: 500 }) : undefined })
  const error = await asked(AbortSignal.timeout(5_000)).catch((failure) => failure)
  expect(error.status).toBe(500)
  expect(mock.names()).toEqual(["getSpaces"])
})

test("a workspace id that is not a UUID is refused before any request", async () => {
  const mock = mockNotion()
  const error = await protocol.open({ auth: { type: "api", key: auth.key, metadata: { spaceId: "not-a-uuid" } }, chat, signal: AbortSignal.timeout(5_000) }).catch((failure) => failure)
  expect(error).toMatchObject({ status: 400, code: "workspace_required" })
  expect(mock.calls).toHaveLength(0)
})

test("the model list is read through the discovered workspace", async () => {
  const mock = mockNotion()
  const models = await protocol.models({ auth })
  expect(Object.keys(models)).toEqual([model.model])
  expect(mock.names()).toEqual(["getSpaces", "getAvailableModels", "getAvailableModels", "authValidate", "getAvailableModels"])
  expect(mock.calls.filter((call) => call.name === "getAvailableModels").every((call) => call.headers["x-notion-space-id"] === call.data.spaceId)).toBe(true)
})

test("the usage card is read through the discovered workspace too", async () => {
  const mock = mockNotion({ handle: (name, call) => name === "getCreditRateLimitStatus" ? Response.json({ status: "not_applicable", space: call.headers["x-notion-space-id"] }) : undefined })
  const plugin = createPlugin(protocol, {})
  const usage = await plugin.auth.usage(async () => auth)
  expect(usage).toMatchObject({ windows: [] })
  expect(mock.calls.find((call) => call.name === "getCreditRateLimitStatus").headers["x-notion-space-id"]).toBe(SPACE)
})

test("the workspace the models answer for wins over a candidate that answers later", async () => {
  const mock = mockNotion({ spaces: spaces([SPACE, OTHER]), answerable: [SPACE] })
  await asked(AbortSignal.timeout(5_000))
  expect(mock.calls.filter((call) => call.name === "getAvailableModels").map((call) => call.data.spaceId)).toEqual([SPACE])
})

test("a workspace or user saved as blank is discovered, not refused", async () => {
  const mock = mockNotion()
  const blank = { type: "api", key: auth.key, metadata: { spaceId: "", activeUserId: "" } }
  for await (const event of await protocol.open({ auth: blank, chat, signal: AbortSignal.timeout(5_000) })) void event
  expect(mock.names()).toContain("getSpaces")
  expect(mock.calls.find((call) => call.name === "createAgentThread").data.spaceId).toBe(SPACE)
  expect(internals.credentials(blank)).toMatchObject({ spaceId: undefined, activeUserId: undefined })
  expect(internals.credentials({ type: "api", key: auth.key, metadata: { spaceId: null, activeUserId: null } })).toMatchObject({ spaceId: undefined, activeUserId: undefined })
  // A value that is present but not a UUID is still refused before any request.
  expect(() => internals.credentials({ type: "api", key: auth.key, metadata: { spaceId: "not-a-uuid" } })).toThrow()
})
