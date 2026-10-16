import { createHash, randomUUID } from "node:crypto"
import { ProviderError } from "./core.mjs"
import { readNDJSON, transcriptEvents, sessionError } from "./transcript.mjs"

const ORIGIN = "https://app.notion.com"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sessions = new Map()
const catalogs = new Map()
const TTL = 30 * 60 * 1000
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function cookie(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.trim() || /[\r\n]/.test(auth.key)) {
    throw new ProviderError(401, "session_required", "Sign in with the Notion web session's Cookie header.")
  }
  return auth.key.trim()
}

// credentials reads what the sign-in states: the Cookie header, and the
// workspace and user where the account carries them. The workspace is not
// required: an account without one has it resolved from the session itself, so
// nobody has to type a UUID.
function credentials(auth) {
  const key = cookie(auth)
  const metadata = auth?.metadata ?? {}
  const spaceId = metadata.spaceId
  if (spaceId !== undefined && (typeof spaceId !== "string" || !UUID.test(spaceId))) throw new ProviderError(400, "workspace_required", "The Notion workspace id must be a UUID.")
  const activeUserId = metadata.activeUserId
  if (activeUserId !== undefined && (typeof activeUserId !== "string" || !UUID.test(activeUserId))) throw new ProviderError(400, "invalid_active_user", "The Notion active user id must be a UUID.")
  return { cookie: key, spaceId, activeUserId }
}

async function call(name, data, account, signal) {
  const headers = { "Content-Type": "application/json", Cookie: account.cookie, Origin: ORIGIN }
  if (account.spaceId) headers["x-notion-space-id"] = account.spaceId
  if (account.activeUserId) headers["x-notion-active-user-header"] = account.activeUserId
  const response = await fetch(`${ORIGIN}/api/v3/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(data), signal, redirect: "error",
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const code = response.status === 401 ? "session_expired" : response.status === 403 ? "workspace_forbidden" : response.status === 429 ? "rate_limited" : "upstream_http_error"
    throw new ProviderError(response.status, code, `Notion AI refused the request (HTTP ${response.status}).`)
  }
  return response
}

const resolved = new Map()
const RESOLVED_TTL = 30 * 60 * 1000

// workspace asks the session which workspace its AI can be asked in: getSpaces
// names the ones the user belongs to, and the one that answers the model
// catalog is the account's. The answer is kept, so the question is asked once
// per session instead of on every request.
async function workspace(read, signal) {
  const key = digest(read.cookie)
  const cached = resolved.get(key)
  if (cached && Date.now() - cached.at < RESOLVED_TTL) return cached
  const body = await json("getSpaces", {}, { cookie: read.cookie }, signal)
  const candidates = []
  let activeUserId
  for (const entry of Object.values(body ?? {})) {
    if (!entry || typeof entry !== "object") continue
    for (const spaceId of Object.keys(entry.space ?? {})) if (UUID.test(spaceId) && !candidates.includes(spaceId)) candidates.push(spaceId)
    for (const id of Object.keys(entry.notion_user ?? {})) if (UUID.test(id) && !activeUserId) activeUserId = id
  }
  if (!candidates.length) throw new ProviderError(404, "workspace_not_found", "This Notion session belongs to no workspace the AI can be asked in.")
  const user = read.activeUserId ?? activeUserId
  let last
  for (const spaceId of candidates) {
    const answer = { cookie: read.cookie, spaceId, activeUserId: user }
    try {
      const probe = await call("getAvailableModels", { spaceId }, answer, signal)
      // The answer that names the workspace is the catalog itself, so it is
      // kept rather than asked for again by the request that follows.
      const payload = await probe.json().catch(() => undefined)
      if (payload && Array.isArray(payload.models)) keepModels(digest([answer.cookie, spaceId, user]), payload)
      else await probe.body?.cancel().catch(() => {})
      while (resolved.size >= 256) resolved.delete(resolved.keys().next().value)
      resolved.set(key, { spaceId, activeUserId: user, at: Date.now() })
      return { spaceId, activeUserId: user, at: Date.now() }
    } catch (error) {
      last = error
    }
  }
  throw last instanceof ProviderError ? last : new ProviderError(502, "workspace_unreadable", "Notion did not answer for any of this session's workspaces.")
}

// accountOf is the account a request runs as, with the workspace resolved from
// the session when the sign-in did not state one.
async function accountOf(auth, signal) {
  const read = credentials(auth)
  if (read.spaceId) return read
  const found = await workspace(read, signal)
  return { cookie: read.cookie, spaceId: found.spaceId, activeUserId: read.activeUserId ?? found.activeUserId }
}

async function json(name, data, account, signal) {
  const response = await call(name, data, account, signal)
  try { return await response.json() } catch { throw new ProviderError(502, "invalid_upstream_json", "Notion AI returned invalid JSON.") }
}

function eligible(entry) {
  return typeof entry?.model === "string" && typeof entry?.modelMessage === "string" && entry.agentService && !entry.agentService.isDisabled && !entry.isDisabled && !entry.restrictedForPersonalAgent
}

async function catalog(account, signal, refresh = false) {
  const key = digest([account.cookie, account.spaceId, account.activeUserId])
  const cached = catalogs.get(key)
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.models
  const response = await json("getAvailableModels", { spaceId: account.spaceId }, account, signal)
  return keepModels(key, response)
}

// keepModels reads the catalog the way the web client shows it — minus what the
// plan and the workspace don't serve — and keeps it for the next minute.
function keepModels(key, response) {
  if (!Array.isArray(response.models)) throw new ProviderError(502, "invalid_model_catalog", "Notion AI returned an unsupported model catalog.")
  const models = response.modelSelectionRestricted || response.restrictedGeoHiddenModelModes?.includes("agent_service") ? [] : response.models.filter(eligible)
  while (catalogs.size >= 256) catalogs.delete(catalogs.keys().next().value)
  catalogs.set(key, { models, at: Date.now() })
  return models
}

function modelEntry(entry) {
  const efforts = entry.modelConfiguration?.supportedReasoningEfforts ?? []
  return {
    id: entry.model, providerID: "notion", name: entry.modelMessage,
    api: { id: entry.model, url: "https://notion.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active", options: {}, headers: {},
    // Zero denotes an unknown limit here, not an asserted vendor allowance.
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false, reasoning: efforts.length > 0, attachment: false, toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false,
    },
    variants: Object.fromEntries(efforts.filter((effort) => typeof effort === "string").map((effort) => [effort, { reasoningEffort: effort }])),
  }
}

function initialText(messages) {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content
  return "Conversation supplied by the client. Follow the system/developer instructions and answer the last user message.\n\n" + messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n")
}

function content(value) {
  return [{ type: "text", text: [[value]] }]
}

function take(key) {
  for (const [entry, value] of sessions) if (Date.now() - value.at > TTL) sessions.delete(entry)
  const value = sessions.get(key)
  sessions.delete(key) // A thread can only advance from this exact history once.
  return value
}

function remember(key, threadId, sequence) {
  while (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
  sessions.set(key, { threadId, sequence, at: Date.now() })
}

// ---- quota -----------------------------------------------------------------
// getCreditRateLimitStatus is the allowance card the web client shows: a
// rolling window and the billing period's, as percentages. Resets are only
// what the vendor states; a missing stop is unknown, never guessed. A bucket
// the vendor leaves unexposed (state not_exposed) is unknown too, not zero.
// getAIUsageEligibilityV2 adds the premium credit balance beside them.

const UNITS = { s: ["second", 1], m: ["minute", 60], h: ["hour", 3600], d: ["day", 86400] }

function percent(used, limit) {
  const u = typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined
  const l = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
  return u === undefined || l === undefined ? undefined : (100 * u) / l
}

function rollingWindow(entry, fallbackReset) {
  const used = percent(entry?.used, entry?.limit)
  if (used === undefined) return undefined
  const label = typeof entry?.window === "string" ? entry.window.trim() : ""
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(label)
  const [unit, size] = match ? UNITS[match[2].toLowerCase()] : []
  const count = match ? Number(match[1]) : undefined
  const reset = [entry?.resetsInSeconds, fallbackReset].find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
  return {
    name: match ? `${match[1]} ${unit}${count === 1 ? "" : "s"}` : label || "Rolling window",
    used,
    ...(count ? { span: count * size } : {}),
    ...(reset !== undefined ? { resetSecs: reset } : {}),
  }
}

function billingWindow(entry) {
  const used = percent(entry?.used, entry?.limit)
  if (used === undefined) return undefined
  const end = typeof entry?.periodEndMs === "number" && Number.isFinite(entry.periodEndMs) && entry.periodEndMs > 0 ? entry.periodEndMs : undefined
  return { name: "Month", used, ...(end !== undefined ? { resetsAt: new Date(end).toISOString() } : {}) }
}

function quotaWindows(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  if (data.status === "not_applicable") return []
  const resolved = Array.isArray(data.allowances) ? data.allowances.filter((entry) => entry?.state === "resolved") : []
  return [
    data.window ? rollingWindow(data.window, data.resetsInSeconds) : rollingWindow(resolved.find((entry) => entry.cadence === "rolling"), data.resetsInSeconds),
    data.billingPeriodWindow ? billingWindow(data.billingPeriodWindow) : billingWindow(resolved.find((entry) => entry.cadence === "billing_period")),
  ].filter(Boolean)
}

const quotaError = (error) =>
  error instanceof ProviderError ? error.message : "The Notion AI quota could not be read."

async function quota({ auth }) {
  const signal = AbortSignal.timeout(30_000)
  let account
  try {
    account = await accountOf(auth, signal)
  } catch (error) {
    return { error: quotaError(error), windows: [], signIn: error?.status === 401 ? "expired" : "kept" }
  }
  let payload
  try {
    payload = await json("getCreditRateLimitStatus", { spaceId: account.spaceId }, account, signal)
  } catch (error) {
    return { error: quotaError(error), windows: [], signIn: error?.status === 401 ? "expired" : "kept" }
  }
  const windows = quotaWindows(payload)
  if (windows === undefined) return { error: "Notion AI returned an unsupported quota response.", windows: [], signIn: "kept" }
  let balance
  try {
    const eligibility = await json("getAIUsageEligibilityV2", { spaceId: account.spaceId }, account, signal)
    const total = eligibility?.premiumCredits?.totalCreditBalance
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) balance = `${total} credits`
  } catch {
    // The premium credit line is optional; its failure must not hide the windows.
  }
  return { windows, ...(balance !== undefined ? { balance } : {}) }
}

export default {
  async models({ auth }) {
    const signal = AbortSignal.timeout(30_000)
    const account = await accountOf(auth, signal)
    const valid = await call("authValidate", {}, account, signal)
    await valid.body?.cancel().catch(() => {})
    if (valid.status !== 200) throw new ProviderError(401, "session_expired", "The Notion web session is not valid.")
    const entries = await catalog(account, signal, true)
    return Object.fromEntries(entries.map((entry) => [entry.model, modelEntry(entry)]))
  },
  async open({ auth, chat, signal }) {
    const account = await accountOf(auth, signal)
    const models = await catalog(account, signal)
    const model = models.find((entry) => entry.model === chat.model)
    if (!model) throw new ProviderError(403, "model_unavailable", "This Notion workspace does not offer the requested model for personal agents.")
    const effort = chat.reasoning_effort ?? model.modelConfiguration?.defaultReasoningEffort
    if (effort !== undefined && !model.modelConfiguration?.supportedReasoningEfforts?.includes(effort)) {
      throw new ProviderError(400, "reasoning_effort_unavailable", "The requested reasoning effort is not offered for this Notion model.")
    }
    const last = chat.messages.at(-1)
    if (last.role !== "user") throw new ProviderError(400, "user_message_required", "The conversation must end with a user message.")
    const accountId = digest([account.cookie, account.spaceId, account.activeUserId, chat.model, effort])
    const historyKey = (messages) => digest([accountId, messages])
    let previous = take(historyKey(chat.messages.slice(0, -1)))
    let afterSequence = 0
    if (previous) {
      const before = await json("getThreadTranscript", { spaceId: account.spaceId, threadId: previous.threadId, direction: "backward", limit: 10 }, account, signal)
      // If the user advanced this thread in Notion, the client's history is no
      // longer its history. Start a new thread instead of mixing conversations.
      if (before.session?.sequence !== previous.sequence || before.session?.status !== "idle") previous = undefined
      else afterSequence = previous.sequence
    }
    let threadId
    if (previous) {
      threadId = previous.threadId
      await json("sendEventToAgentThread", { spaceId: account.spaceId, threadId, event: { type: "user.message", content: content(last.content) }, surface: "full_page_chat", clientEventId: randomUUID() }, account, signal)
    } else {
      threadId = randomUUID()
      const created = await json("createAgentThread", {
        type: "personal_agent", spaceId: account.spaceId, threadId,
        model: chat.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        createdSource: "full_page_chat", content: content(initialText(chat.messages)),
        policies: { approval_mode: "ask", disable_internet_access: true, disable_computer_file_downloads: true },
        agentMemorySettings: { useMemories: false, excludeChatFromMemories: true },
        browserEnabled: false, clientMessageId: randomUUID(),
      }, account, signal)
      if (typeof created.threadId !== "string" || !UUID.test(created.threadId)) throw new ProviderError(502, "unexpected_thread", "Notion AI returned an invalid thread id.")
      threadId = created.threadId
    }
    const page = await json("getThreadTranscript", { spaceId: account.spaceId, threadId, direction: "backward", limit: 10 }, account, signal)
    if (page.type !== "agent_service_transcript_page" || !Array.isArray(page.patches)) throw new ProviderError(502, "invalid_transcript", "Notion AI returned an unsupported transcript page.")
    if (afterSequence === 0 || page.session?.sequence > afterSequence || page.session?.last_turn_allowance?.sequence > afterSequence) sessionError(page.session)
    const completedOnPage = page.patches.some((patch) => patch.op === "put" && patch.entity?.kind === "turn_completed" && patch.entity.sequence > afterSequence)
    let liveResponse
    if (!completedOnPage) {
      if (typeof page.forward_cursor !== "string") throw new ProviderError(502, "missing_cursor", "Notion AI did not return a transcript cursor.")
      // Establish the HTTP stream before returning client headers, so an
      // expired session at this endpoint can still be reported as HTTP 401.
      liveResponse = await call("listenToThreadTranscript", { spaceId: account.spaceId, threadId, cursor: page.forward_cursor, includeProvisionalUserMessages: true, includeQueueChanges: false }, account, signal)
    }
    async function* frames() {
      yield page
      if (liveResponse) yield* readNDJSON(liveResponse.body, signal)
    }
    return (async function* () {
      let answer = ""
      try {
        for await (const event of transcriptEvents(frames(), signal, { afterSequence })) {
          if (event.type === "text") answer += event.text
          else if (event.type === "done") remember(historyKey([...chat.messages, { role: "assistant", content: answer }]), threadId, event.sequence)
          yield event
        }
      } finally { await liveResponse?.body?.cancel().catch(() => {}) }
    })()
  },
  usage: quota,
}

export const _internal = { cookie, credentials, accountOf, workspace, resolved, RESOLVED_TTL, keepModels, initialText, content, sessions, catalogs, eligible, modelEntry, percent, rollingWindow, billingWindow, quotaWindows }
