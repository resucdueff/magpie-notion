import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { NotionPlugin } from "../index.mjs"
import { _internal as protocolInternals } from "../protocol.mjs"

// The fixture is a redacted live getCreditRateLimitStatus response. Assertions
// follow https://usemagpie.ai/docs/plugins#usage, not CodexBar UI fields.
const realFixture = JSON.parse(readFileSync(new URL("../fixtures/real-quota.json", import.meta.url)))
const token = "offline-token-v2"
const auth = { type: "api", key: token, metadata: { spaceId: "11111111-1111-4111-8111-111111111111", activeUserId: "22222222-2222-4222-8222-222222222222" } }
const copy = () => structuredClone(realFixture)
const cookieValue = (header, name) => header.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1)
const premiumFixture = {
  basicCredits: { userLimit: 50, userUsage: 1 },
  premiumCredits: {
    totalCreditBalance: 300, creditsInOverage: 0, overageLimit: 0,
    servicePeriodStartMs: 1792162800000,
    perSource: { monthlyAllocated: { limit: 300, usageTotal: 0 }, monthlyCommitted: { limit: 0, usageTotal: 0 }, stackedTrial: { limit: 0, usageTotal: 0 }, yearlyElastic: { limit: 0, usageTotal: 0 } },
  },
}
afterEach(() => { protocolInternals.useFetch(undefined) })

async function usage(payload = copy(), options = {}) {
  const calls = []
  protocolInternals.useFetch(async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    calls.push({ name, url: String(url), ...init })
    if (options.throw) throw new Error("private-quota-diagnostic")
    if (name === "authValidate") return new Response(null, { status: options.authStatus ?? 200 })
    if (name === "getAIUsageEligibilityV2") {
      if (options.v2Status) return new Response("private-v2-diagnostic", { status: options.v2Status })
      return Response.json(options.v2 ?? {})
    }
    if (name !== "getCreditRateLimitStatus") throw new Error("Unexpected offline endpoint: " + name)
    if (options.status) return new Response("private-quota-diagnostic", { status: options.status })
    if (options.invalidJSON) return new Response("private-quota-diagnostic")
    return Response.json(payload)
  })
  const hooks = await NotionPlugin()
  expect(typeof hooks.auth.usage).toBe("function")
  const result = await hooks.auth.usage(async () => options.auth ?? auth)
  return { result, calls }
}

function singleWindow(overrides = {}) {
  const data = copy()
  delete data.billingPeriodWindow
  delete data.allowances
  Object.assign(data.window, overrides)
  return data
}

test("quota: real response becomes two percentage windows without duplicate allowance buckets", async () => {
  const { result, calls } = await usage()
  expect(result.error).toBeFalsy()
  expect(result.windows).toHaveLength(2)
  const rolling = result.windows.find((w) => w.span === 21600)
  const billing = result.windows.find((w) => w.used === 0.01)
  expect(rolling.used).toBeCloseTo(0.03, 8)
  expect(billing.used).toBeCloseTo(0.01, 8)
  expect(billing.resetsAt).toBe(new Date(realFixture.billingPeriodWindow.periodEndMs).toISOString())
  expect(rolling.resetSecs === 20101 || Math.abs(Date.parse(rolling.resetsAt) - Date.now() - 20101 * 1000) < 3000).toBe(true)
  expect(calls.filter((c) => c.name === "getCreditRateLimitStatus")).toHaveLength(1)
  for (const w of result.windows) expect(w.name.length).toBeGreaterThan(0)
})

test("quota: arbitrary denominators are converted to percentages", async () => {
  const data = copy()
  delete data.allowances
  Object.assign(data.window, { used: 50, limit: 200 })
  Object.assign(data.billingPeriodWindow, { used: 30, limit: 60 })
  const { result } = await usage(data)
  expect(result.windows.map((w) => w.used).sort((a, b) => a - b)).toEqual([25, 50])
})

test("quota: overspending remains above 100 percent", async () => {
  const { result } = await usage(singleWindow({ used: 250, limit: 200 }))
  expect(result.windows).toHaveLength(1)
  expect(result.windows[0].used).toBe(125)
})

test("quota: a verified zero usage is displayed as zero", async () => {
  const { result } = await usage(singleWindow({ used: 0, limit: 75 }))
  expect(result.windows).toHaveLength(1)
  expect(result.windows[0].used).toBe(0)
})

test("quota: not_applicable does not fabricate unused allowance", async () => {
  const { result } = await usage({ status: "not_applicable" })
  expect(result.windows ?? []).toEqual([])
  expect(result.balance).toBeUndefined()
  expect(result.signIn).not.toBe("expired")
})

test("quota: unexposed auto/flex buckets do not become zero-percent windows", async () => {
  const { result } = await usage({ status: "within_limit", allowances: realFixture.allowances.filter((a) => a.state === "not_exposed") })
  expect(result.windows ?? []).toEqual([])
})

test("quota: resolved allowance entries work when legacy top-level windows are absent", async () => {
  const { result } = await usage({ status: "within_limit", allowances: realFixture.allowances })
  expect(result.windows).toHaveLength(2)
  expect(result.windows.map((w) => w.used).sort((a, b) => a - b)).toEqual([0.01, 0.03])
})

test.each([undefined, null, -1, "5", false])("quota: missing or invalid used count is not zero", async (used) => {
  const { result } = await usage(singleWindow({ used }))
  expect(result.windows ?? []).toEqual([])
})

test.each([undefined, null, 0, -1, "100", false])("quota: missing or invalid limit never creates a percentage", async (limit) => {
  const { result } = await usage(singleWindow({ limit }))
  expect(result.windows ?? []).toEqual([])
})

test.each([null, {}, [], "wrong response shape"])('quota: malformed payload has no invented window', async (payload) => {
  const { result } = await usage(payload)
  expect(result.windows ?? []).toEqual([])
  expect(result.signIn).not.toBe("expired")
})

test("quota: monthly reset is the exact server timestamp across UTC month boundaries", async () => {
  const data = copy()
  delete data.window
  delete data.allowances
  data.billingPeriodWindow.periodEndMs = Date.parse("2027-03-01T00:00:00.001Z")
  const { result } = await usage(data)
  expect(result.windows).toHaveLength(1)
  expect(result.windows[0].resetsAt).toBe("2027-03-01T00:00:00.001Z")
})

test("quota: missing monthly period end never becomes a guessed month-end date", async () => {
  const data = copy()
  delete data.window
  delete data.allowances
  delete data.billingPeriodWindow.periodEndMs
  const { result } = await usage(data)
  for (const window of result.windows ?? []) {
    expect(window.resetsAt).toBeUndefined()
    expect(window.resetSecs).toBeUndefined()
    expect(window.span).toBeUndefined()
  }
})

test("quota: missing rolling reset does not infer a fresh six-hour reset", async () => {
  const data = singleWindow()
  delete data.resetsInSeconds
  const { result } = await usage(data)
  for (const window of result.windows ?? []) {
    expect(window.resetsAt).toBeUndefined()
    expect(window.resetSecs).toBeUndefined()
  }
})

test.each([-1, "tomorrow", null])("quota: malformed rolling reset is omitted rather than coerced", async (resetsInSeconds) => {
  const data = singleWindow()
  data.resetsInSeconds = resetsInSeconds
  const { result } = await usage(data)
  for (const window of result.windows ?? []) {
    expect(window.resetsAt).toBeUndefined()
    expect(window.resetSecs).toBeUndefined()
  }
})

test("quota: requests use the selected account and workspace without logging them", async () => {
  const { result, calls } = await usage()
  const call = calls.find((c) => c.name === "getCreditRateLimitStatus")
  expect(call.url).toBe("https://app.notion.com/api/v3/getCreditRateLimitStatus")
  expect(call.method).toBe("POST")
  expect(JSON.parse(call.body).spaceId).toBe(auth.metadata.spaceId)
  expect(cookieValue(call.headers.Cookie, "token_v2")).toBe(token)
  expect(call.headers.Cookie).toContain("notion_users=" + encodeURIComponent(JSON.stringify([auth.metadata.activeUserId])))
  expect(call.headers["x-notion-space-id"]).toBe(auth.metadata.spaceId)
  expect(call.headers["x-notion-active-user-header"]).toBe(auth.metadata.activeUserId)
  expect(call.redirect).toBe("error")
  expect(JSON.stringify(result)).not.toContain(auth.key)
  expect(JSON.stringify(result)).not.toContain(auth.metadata.spaceId)
})

test("quota: HTTP 401 marks the session expired with no upstream diagnostic", async () => {
  const { result } = await usage(copy(), { status: 401 })
  expect(result.signIn).toBe("expired")
  expect(result.error).toBeTruthy()
  expect(result.windows ?? []).toEqual([])
  expect(JSON.stringify(result)).not.toContain("private-quota-diagnostic")
})

test("quota: consecutive accounts do not share usage or identity state", async () => {
  const first = await usage(singleWindow({ used: 12, limit: 100 }))
  const otherAuth = { ...auth, key: "other-" + token, metadata: { ...auth.metadata, spaceId: "33333333-3333-4333-8333-333333333333" } }
  const second = await usage(singleWindow({ used: 73, limit: 100 }), { auth: otherAuth })
  expect(first.result.windows[0].used).toBe(12)
  expect(second.result.windows[0].used).toBe(73)
  const otherCookie = second.calls.find((c) => c.name === "getCreditRateLimitStatus").headers.Cookie
  expect(cookieValue(otherCookie, "token_v2")).toBe(otherAuth.key)
  expect(otherCookie).toContain("notion_users=" + encodeURIComponent(JSON.stringify([otherAuth.metadata.activeUserId])))
})

test.each([403, 429, 503])("quota: HTTP %i does not mislabel sign-in expiry", async (status) => {
  const { result } = await usage(copy(), { status })
  expect(result.signIn).not.toBe("expired")
  expect(result.error).toBeTruthy()
  expect(result.windows ?? []).toEqual([])
  expect(JSON.stringify(result)).not.toContain("private-quota-diagnostic")
})

test.each([{ invalidJSON: true }, { throw: true }])("quota: parse and transport failures are sanitized", async (options) => {
  const { result } = await usage(copy(), options)
  expect(result.error).toBeTruthy()
  expect(result.windows ?? []).toEqual([])
  expect(JSON.stringify(result)).not.toContain("private-quota-diagnostic")
})

test("quota: invalid account metadata fails before network traffic", async () => {
  const { result, calls } = await usage(copy(), { auth: { ...auth, metadata: { spaceId: "bad-id" } } })
  expect(calls).toHaveLength(0)
  expect(result.error).toBeTruthy()
  expect(result.windows ?? []).toEqual([])
})

test("quota: inference HTTP 401 also sends Magpie's expired response header", async () => {
  protocolInternals.useFetch(async () => new Response("private-quota-diagnostic", { status: 401 }))
  const hooks = await NotionPlugin()
  const loader = await hooks.auth.loader(async () => auth)
  const response = await loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "offline" }] }) })
  expect(response.status).toBe(401)
  expect(response.headers.get("x-magpie-sign-in")).toBe("expired")
  expect(await response.text()).not.toContain("private-quota-diagnostic")
})

test("quota V2: actual 300-credit balance is independent from standard allowances", async () => {
  const { result, calls } = await usage(copy(), { v2: premiumFixture })
  expect(result.error).toBeFalsy()
  expect(parseFloat(result.balance)).toBe(300)
  expect(result.windows).toHaveLength(2)
  expect(result.windows.map((w) => w.used).sort((a, b) => a - b)).toEqual([0.01, 0.03])
  const call = calls.find((c) => c.name === "getAIUsageEligibilityV2")
  expect(JSON.parse(call.body).spaceId).toBe(auth.metadata.spaceId)
  expect(cookieValue(call.headers.Cookie, "token_v2")).toBe(token)
  expect(call.headers.Cookie).toContain("notion_users=" + encodeURIComponent(JSON.stringify([auth.metadata.activeUserId])))
})

test("quota V2: a true zero balance wins over positive perSource limits", async () => {
  const v2 = structuredClone(premiumFixture)
  v2.premiumCredits.totalCreditBalance = 0
  const { result } = await usage(copy(), { v2 })
  expect(parseFloat(result.balance)).toBe(0)
})

test("quota V2: fractional balance is retained", async () => {
  const v2 = structuredClone(premiumFixture)
  v2.premiumCredits.totalCreditBalance = 12.75
  const { result } = await usage(copy(), { v2 })
  expect(parseFloat(result.balance)).toBe(12.75)
})

test("quota V2: legacy basicCredits counters never replace current standard windows", async () => {
  const v2 = structuredClone(premiumFixture)
  Object.assign(v2.basicCredits, { userLimit: 50, userUsage: 49 })
  const { result } = await usage(copy(), { v2 })
  expect(result.windows).toHaveLength(2)
  expect(result.windows.map((w) => w.used).sort((a, b) => a - b)).toEqual([0.01, 0.03])
})

test("quota V2: HTTP 403 preserves readable standard quota and does not expire sign-in", async () => {
  const { result } = await usage(copy(), { v2Status: 403 })
  expect(result.signIn).not.toBe("expired")
  expect(result.error).toBeFalsy()
  expect(result.windows).toHaveLength(2)
  expect(JSON.stringify(result)).not.toContain("private-v2-diagnostic")
  expect(result.balance).toBeUndefined()
})

test.each([undefined, null, "unlimited", "unknown"])('quota V2: unknown or unlimited overage never fabricates an extra balance', async (overageLimit) => {
  const v2 = structuredClone(premiumFixture)
  v2.premiumCredits.overageLimit = overageLimit
  const { result } = await usage(copy(), { v2 })
  expect(parseFloat(result.balance)).toBe(300)
})

test("quota V2: service period start does not imply a guessed end or reset", async () => {
  const { result } = await usage({ status: "not_applicable" }, { v2: premiumFixture })
  expect(parseFloat(result.balance)).toBe(300)
  expect(result.until).toBeUndefined()
  for (const window of result.windows ?? []) expect(window.resetsAt).toBeUndefined()
})

test("quota: a readable allowance stands in for an unreadable top-level window", async () => {
  const data = {
    status: "within_limit",
    window: { window: "6h" },
    billingPeriodWindow: { window: "month" },
    allowances: [
      { cadence: "rolling", state: "resolved", used: 1, limit: 100, window: "6h", resetsInSeconds: 60 },
      { cadence: "billing_period", state: "resolved", used: 2, limit: 100, periodEndMs: 1794841200000 },
    ],
  }
  const { result } = await usage(data)
  expect(result.error).toBeFalsy()
  expect(result.windows).toHaveLength(2)
  expect(result.windows.map((w) => w.used).sort((a, b) => a - b)).toEqual([1, 2])
  expect(result.windows.find((w) => w.used === 1).resetSecs).toBe(60)
  expect(result.windows.find((w) => w.used === 2).resetsAt).toBe(new Date(1794841200000).toISOString())
  // A window whose numbers do not read is the same as one that is not there:
  // the readable bucket below it is used instead.
  const zeroLimit = singleWindow({ used: 5, limit: 0 })
  zeroLimit.allowances = [{ cadence: "rolling", state: "resolved", used: 5, limit: 100, window: "6h" }]
  const fallback = await usage(zeroLimit)
  expect(fallback.result.windows).toHaveLength(1)
  expect(fallback.result.windows[0].used).toBe(5)
})

test("quota: a response that reads no window at all is an error, not an empty account", async () => {
  for (const payload of [{}, { status: "within_limit" }, { status: "within_limit", window: {} }]) {
    const { result } = await usage(payload)
    expect(result.error).toBe("Notion AI returned an unsupported quota response.")
    expect(result.windows ?? []).toEqual([])
    expect(result.signIn).not.toBe("expired")
  }
})

test.each([
  { allowances: [{}] },
  { allowances: [null] },
  { allowances: [{ state: "unknown" }] },
  { allowances: [{ state: "not_exposed" }, {}] },
])("quota: malformed allowances are not explicit vendor withholding (%j)", async ({ allowances }) => {
  const { result } = await usage({ status: "within_limit", allowances })
  expect(result.error).toBe("Notion AI returned an unsupported quota response.")
  expect(result.windows).toEqual([])
  expect(result.signIn).not.toBe("expired")
})
