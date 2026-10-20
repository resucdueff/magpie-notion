import { createHash, randomUUID } from "node:crypto"
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base"
import { ProviderError } from "./core.mjs"
import { readNDJSON, transcriptEvents, sessionError } from "./transcript.mjs"

const ORIGIN = "https://app.notion.com"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sessions = new Map()
const catalogs = new Map()
const TTL = 30 * 60 * 1000
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const moduleFetch = globalThis.fetch
const CONTROL = /[\x00-\x1f\x7f]/
const encoder = new TextEncoder()
const READ_RETRIES = new Set([
  "getSpaces",
  "getAvailableModels",
  "authValidate",
  "getThreadTranscript",
  "getCreditRateLimitStatus",
  "getAIUsageEligibilityV2",
])
const MAX_READ_RETRIES = 2
const MAX_BACKWARD_PAGES = 8
const MAX_ERROR_DETAIL_BYTES = 16 * 1024
const TRANSCRIPT_PREAMBLE = "Conversation supplied by the client. Follow the system/developer instructions and answer the last user message."
// These are conservative adapter safety windows, not Notion-published limits.
// cl100k_base is only an approximation of Notion's private tokenizer, so the
// 40K window leaves roughly 11K tokens beneath the observed ~51K failure edge.
const CONTEXT_BUDGET = 40_000
const OUTPUT_BUDGET = 8192
const THREAD_TOKEN_BUDGET = CONTEXT_BUDGET
const TURN_OVERHEAD_TOKENS = 256
// This is a transport/DoS ceiling, not a context-window decision.
const MAX_INPUT_BYTES = 2 * 1024 * 1024
let impitClient
let impitLoading
let fetchOverride

// A stable UUID for Notion's device cookie. The session token selects it, so
// repeated requests look like one browser without writing a new identifier
// back into the saved sign-in.
function deviceId(token) {
  const bytes = createHash("sha256").update(token).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function cookieFields(header) {
  return header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=")
    if (separator < 1) return { name: part, value: undefined }
    return { name: part.slice(0, separator).trim(), value: part.slice(separator + 1) }
  })
}

function hasUser(value, activeUserId) {
  if (typeof value !== "string" || !value) return false
  try {
    return decodeURIComponent(value).includes(activeUserId)
  } catch {
    return value.includes(activeUserId)
  }
}

// The web client sends a device cookie and a notion_users cookie naming the
// active account. Derive the former from token_v2 and add the latter when the
// sign-in names a user, keeping every other cookie exactly as supplied.
function normalizeCookie(header, activeUserId) {
  const fields = cookieFields(header)
  if (!fields.some((field) => field.name === "device_id")) {
    const token = fields.find((field) => field.name === "token_v2")?.value
    if (token !== undefined && token !== "") fields.push({ name: "device_id", value: deviceId(token) })
  }
  if (activeUserId && !fields.some((field) => field.name === "notion_users" && hasUser(field.value, activeUserId))) {
    const encoded = encodeURIComponent(JSON.stringify([activeUserId]))
    const existing = fields.find((field) => field.name === "notion_users")
    if (existing) existing.value = encoded
    else fields.push({ name: "notion_users", value: encoded })
  }
  return fields.map((field) => field.value === undefined ? field.name : `${field.name}=${field.value}`).join("; ")
}

async function impit() {
  if (impitClient) return impitClient
  if (!impitLoading) {
    impitLoading = import("impit")
      .then(({ Impit }) => (impitClient = new Impit({ browser: "chrome", followRedirects: false })))
      .catch(() => {
        impitLoading = undefined
        throw new ProviderError(503, "transport_unavailable", "Reinstall the plugin so Magpie can install its impit dependency.")
      })
  }
  return impitLoading
}

async function request(name, url, init) {
  if (fetchOverride) return fetchOverride(url, init)
  // Only thread creation needs Chrome's browser fingerprint. Other calls keep
  // the fetch captured at module load so a host replacing globalThis.fetch
  // cannot silently change their transport.
  if (name !== "createAgentThread") return moduleFetch(url, init)
  const client = await impit()
  try {
    return await client.fetch(url, init)
  } catch (error) {
    // Some impit builds reject the request-level redirect option. The shared
    // client still refuses to follow redirects, so omitting it is safe: a 3xx
    // response reaches call() and becomes an error there.
    if (!/redirect/i.test(String(error?.message ?? ""))) throw error
    const { redirect, ...withoutRedirect } = init
    return client.fetch(url, withoutRedirect)
  }
}

function useFetch(fetch) {
  if (fetch !== undefined && typeof fetch !== "function") throw new TypeError("The Notion fetch override must be a function.")
  fetchOverride = fetch
}

function wait(ms, signal) {
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
      reject(signal.reason)
    }
    if (signal?.aborted) aborted()
    else signal?.addEventListener("abort", aborted, { once: true })
  })
}

// Accept either the token value by itself or a Cookie header the user pasted by
// mistake. Only token_v2 is kept, so unrelated pasted cookies never reach the
// upstream request.
function cookie(auth) {
  const reject = () => new ProviderError(401, "session_required", "请粘贴 Notion 的 token_v2。")
  if (auth?.type !== "api" || typeof auth.key !== "string" || CONTROL.test(auth.key)) throw reject()
  const pasted = auth.key.trim().replace(/^Cookie\s*:\s*/i, "")
  if (!pasted) throw reject()
  const field = cookieFields(pasted).find((entry) => entry.name === "token_v2")
  if (field) {
    const token = field.value?.trim()
    if (!token || CONTROL.test(token)) throw reject()
    return `token_v2=${token}`
  }
  // A Cookie header without token_v2 is not a token, even when it has one field.
  if (pasted.includes("=") || pasted.includes(";")) throw reject()
  return `token_v2=${pasted}`
}

// A field the sign-in left blank is not a value: an unanswered optional prompt
// is saved as an empty string, and a blank workspace or user must mean
// "discover it" the same way an absent one does.
function optional(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string" && !value.trim()) return undefined
  return value
}

// credentials reads the pasted token and the workspace/user metadata where the
// account carries them. The workspace is not required: an account without one
// has it resolved from the session itself, so nobody has to type a UUID.
function credentials(auth) {
  const key = cookie(auth)
  const metadata = auth?.metadata ?? {}
  const spaceId = optional(metadata.spaceId)
  if (spaceId !== undefined && (typeof spaceId !== "string" || !UUID.test(spaceId))) throw new ProviderError(400, "workspace_required", "The Notion workspace id must be a UUID.")
  const activeUserId = optional(metadata.activeUserId)
  if (activeUserId !== undefined && (typeof activeUserId !== "string" || !UUID.test(activeUserId))) throw new ProviderError(400, "invalid_active_user", "The Notion active user id must be a UUID.")
  return { cookie: key, spaceId, activeUserId }
}

async function call(name, data, account, signal) {
  const headers = {
    Accept: name === "listenToThreadTranscript" ? "application/x-ndjson" : "application/json",
    "Content-Type": "application/json",
    Cookie: normalizeCookie(account.cookie, account.activeUserId),
    Origin: ORIGIN,
    "notion-audit-log-platform": "web",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  }
  if (account.spaceId) headers["x-notion-space-id"] = account.spaceId
  if (account.activeUserId) headers["x-notion-active-user-header"] = account.activeUserId
  for (let attempt = 0; ; attempt++) {
    const response = await request(name, `${ORIGIN}/api/v3/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(data), signal, redirect: "error",
    })
    if (response.ok) return response
    const retryAfter = response.headers.get("Retry-After")?.trim()
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
    if (response.status === 400 && ["createAgentThread", "sendEventToAgentThread"].includes(name)) {
      // Read a bounded prefix only to classify the failure locally. The body is
      // never logged or returned because it can contain account diagnostics.
      const detail = await boundedBodyText(response, MAX_ERROR_DETAIL_BYTES)
      const contextExceeded = /(?:context[\s_-]*(?:length|window|limit)|(?:maximum|max)[\s_-]*context|too\s+many\s+tokens|input[\s_-]*(?:too\s+long|length)|prompt[\s_-]*(?:too\s+long|length))/i.test(detail)
      throw contextExceeded
        ? new ProviderError(400, "context_length_exceeded", "The Notion conversation context is too large. Compress earlier tool results, shorten the message, or start a new conversation.")
        : new ProviderError(400, "notion_request_rejected", "Notion rejected the personal-agent request. Compress the conversation or start a new thread and try again.")
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 429 && READ_RETRIES.has(name) && attempt < MAX_READ_RETRIES && Number.isSafeInteger(seconds) && seconds <= 5) {
      await wait(seconds * 1000, signal)
      continue
    }
    const code = response.status === 401 ? "session_expired" : response.status === 403 ? "workspace_forbidden" : response.status === 429 ? "rate_limited" : "upstream_http_error"
    throw new ProviderError(response.status, code, `Notion AI refused the request (HTTP ${response.status}).`, retryAfter ? { retryAfter } : undefined)
  }
}

async function boundedBodyText(response, limit) {
  if (!response.body?.getReader) return ""
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (bytes < limit) {
      const next = await reader.read()
      if (next.done) break
      const room = limit - bytes
      const chunk = next.value.length > room ? next.value.subarray(0, room) : next.value
      chunks.push(chunk)
      bytes += chunk.length
      if (chunk.length < next.value.length) break
    }
  } catch {
    // Classification falls back to the generic rejection when a body cannot
    // be read; no upstream diagnostic is surfaced either way.
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(joined)
}

const resolved = new Map()
const RESOLVED_TTL = 30 * 60 * 1000

// workspace asks the session which workspace its AI can be asked in: getSpaces
// names the ones the user belongs to, and the one that answers the model
// catalog is the account's. The answer is kept, so the question is asked once
// per session instead of on every request.
//
// One entry of getSpaces belongs to one user and lists that user's workspaces,
// so the entry's own key is the user those workspaces belong to. The
// notion_user table beside it can name other members of the same workspaces,
// and taking the first user named anywhere in the reply would send
// x-notion-active-user-header naming someone who is not the account.
async function workspace(read, signal) {
  const key = digest([read.cookie, read.activeUserId])
  const cached = resolved.get(key)
  if (cached && Date.now() - cached.at < RESOLVED_TTL) return cached
  const body = await json("getSpaces", {}, { cookie: read.cookie, activeUserId: read.activeUserId }, signal)
  const owners = new Map()
  const candidates = []
  for (const [entryKey, entry] of Object.entries(body ?? {})) {
    if (!entry || typeof entry !== "object") continue
    const users = Object.keys(entry.notion_user ?? {}).filter((id) => UUID.test(id))
    // The entry's key names its user; only an entry with exactly one listed
    // user can stand in for it, because with several there is no telling which
    // one the session is.
    const owner = UUID.test(entryKey) ? entryKey : users.length === 1 ? users[0] : undefined
    for (const spaceId of Object.keys(entry.space ?? {})) {
      if (!UUID.test(spaceId) || owners.has(spaceId)) continue
      owners.set(spaceId, owner)
      candidates.push(spaceId)
    }
  }
  if (!candidates.length) throw new ProviderError(404, "workspace_not_found", "This Notion session belongs to no workspace the AI can be asked in.")
  let last
  let readable
  for (const spaceId of candidates) {
    // A user the sign-in states is the account it meant; otherwise the entry
    // that lists this workspace names the user it belongs to.
    const user = read.activeUserId ?? owners.get(spaceId)
    const answer = { cookie: read.cookie, spaceId, activeUserId: user }
    try {
      const probe = await call("getAvailableModels", { spaceId }, answer, signal)
      // The answer that names the workspace is the catalog itself, so it is
      // kept rather than asked for again by the request that follows.
      const payload = await probe.json().catch(async () => {
        await probe.body?.cancel().catch(() => {})
        return undefined
      })
      if (!payload || !Array.isArray(payload.models)) {
        await probe.body?.cancel().catch(() => {})
        continue
      }
      const models = keepModels(digest([answer.cookie, spaceId, user]), payload)
      readable ??= answer
      if (!models.length) continue
      while (resolved.size >= 256) resolved.delete(resolved.keys().next().value)
      resolved.set(key, { spaceId, activeUserId: user, at: Date.now() })
      return { spaceId, activeUserId: user, at: Date.now() }
    } catch (error) {
      last = error
    }
  }
  if (readable) {
    while (resolved.size >= 256) resolved.delete(resolved.keys().next().value)
    resolved.set(key, { ...readable, at: Date.now() })
    return { ...readable, at: Date.now() }
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
  return typeof entry?.model === "string" && entry.model.trim().length > 0 && typeof entry?.modelMessage === "string" && entry.agentService && !entry.agentService.isDisabled && !entry.isDisabled && !entry.restrictedForPersonalAgent
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
    // Magpie only gives OpenCode a context window when this is published.
    // Its tokenizer can estimate ordinary text very differently from cl100k,
    // so the adapter's 40K safety budget must not become a host preflight
    // limit. The output budget remains useful metadata.
    limit: { output: OUTPUT_BUDGET },
    capabilities: {
      temperature: false, reasoning: efforts.length > 0, attachment: false, toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false,
    },
    variants: Object.fromEntries(efforts.filter((effort) => typeof effort === "string").map((effort) => [effort, { reasoningEffort: effort }])),
  }
}

function tokenCount(value) {
  // Allow literal special-token spellings in ordinary user content. We only
  // need their cost, not their semantic role in a model prompt.
  return countTokens(String(value), { allowedSpecial: "all" })
}

function estimateTokens(value) {
  return tokenCount(value)
}

function utf8Bytes(value) {
  return encoder.encode(String(value)).length
}

function formattedMessage(message) {
  return `[${message.role}]\n${message.content}`
}

function transcriptText(messages, omission) {
  if (!omission && messages.length === 1 && messages[0].role === "user") return messages[0].content
  const body = messages.map(formattedMessage)
  if (omission) body.unshift(omission)
  return `${TRANSCRIPT_PREAMBLE}\n\n${body.join("\n\n")}`
}

function omissionText(messages) {
  const formatted = messages.map(formattedMessage)
  const tokens = formatted.reduce((sum, value) => sum + tokenCount(value), 0)
  const bytes = formatted.reduce((sum, value) => sum + utf8Bytes(value), 0)
  return `[Earlier history omitted / 早期历史已省略]\n${messages.length} earlier messages were omitted to fit the Magpie Notion adapter context budget (${tokens} tokens, ${bytes} UTF-8 bytes).`
}

function contextLengthError(tokens, budget, kind = "history") {
  const subject = kind === "protected"
    ? "The protected system/developer instructions"
    : kind === "latest"
      ? "The latest user message"
      : kind === "combined"
        ? "The protected system/developer instructions and the latest user message together"
        : "The Notion request"
  const guidance = kind === "latest"
    ? "Shorten the latest user message or start a new conversation."
    : kind === "protected"
      ? "Shorten the system/developer instructions or start a new conversation."
      : kind === "combined"
        ? "Shorten the system/developer instructions, shorten the latest user message, or start a new conversation."
        : "Compress earlier tool results, shorten the message, or start a new conversation."
  return new ProviderError(
    400,
    "context_length_exceeded",
    `${subject} exceeds the adapter context token budget (${tokens} > ${budget} tokens). ${guidance}`,
  )
}

// contextPlan keeps every system/developer instruction and the latest user
// message, then fills from the newest history backward in whole messages under
// a real cl100k_base token count. The omission note is counted as part of the
// transcript it describes.
function contextPlan(messages, budget = CONTEXT_BUDGET) {
  if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== "user") {
    throw new ProviderError(400, "user_message_required", "The conversation must end with a user message.")
  }
  const fullText = transcriptText(messages)
  const fullBytes = utf8Bytes(fullText)
  if (fullBytes > MAX_INPUT_BYTES) {
    throw new ProviderError(413, "request_too_large", "The request exceeds the adapter's 2 MB transport safety limit.")
  }
  const full = { tokens: tokenCount(fullText), bytes: fullBytes }
  const protectedIndexes = new Set(messages.flatMap((message, index) => message.role === "system" || message.role === "developer" || index === messages.length - 1 ? [index] : []))
  const candidates = messages.flatMap((_message, index) => protectedIndexes.has(index) ? [] : [index])

  const render = (historyIndexes, omittedIndexes) => {
    const selected = [...protectedIndexes, ...historyIndexes].sort((a, b) => a - b)
    const omission = omittedIndexes.length ? omissionText(omittedIndexes.map((index) => messages[index])) : undefined
    return transcriptText(selected.map((index) => messages[index]), omission)
  }

  const baseline = render([], candidates)
  if (tokenCount(baseline) > budget) {
    const instructions = messages.filter((message) => message.role === "system" || message.role === "developer")
    const instructionTokens = instructions.length ? tokenCount(transcriptText(instructions)) : 0
    const latestTokens = tokenCount(transcriptText([messages.at(-1)]))
    if (instructionTokens > budget) throw contextLengthError(instructionTokens, budget, "protected")
    if (latestTokens > budget) throw contextLengthError(latestTokens, budget, "latest")
    throw contextLengthError(tokenCount(baseline), budget, "combined")
  }

  let firstSelected = candidates.length
  for (let index = candidates.length - 1; index >= 0; index--) {
    const trial = render(candidates.slice(index), candidates.slice(0, index))
    if (tokenCount(trial) > budget) break
    firstSelected = index
  }

  const selectedHistory = candidates.slice(firstSelected)
  const omittedIndexes = candidates.slice(0, firstSelected)
  const text = render(selectedHistory, omittedIndexes)
  const estimated = { tokens: tokenCount(text), bytes: utf8Bytes(text) }
  if (estimated.tokens > budget) throw contextLengthError(estimated.tokens, budget, "history")
  const omittedFormatted = omittedIndexes.map((index) => formattedMessage(messages[index]))
  return {
    text,
    messages: [...protectedIndexes, ...selectedHistory].sort((a, b) => a - b).map((index) => messages[index]),
    full,
    estimated,
    budget,
    fullOverBudget: full.tokens > budget,
    omittedCount: omittedIndexes.length,
    omittedTokens: omittedFormatted.reduce((sum, value) => sum + tokenCount(value), 0),
    omittedBytes: omittedFormatted.reduce((sum, value) => sum + utf8Bytes(value), 0),
  }
}

function initialText(messages, budget = CONTEXT_BUDGET) {
  return contextPlan(messages, budget).text
}

function content(value) {
  return [{ type: "text", text: [[value]] }]
}

function take(key) {
  for (const [entry, value] of sessions) {
    if (Date.now() - value.at > TTL) {
      sessions.delete(entry)
      claims.delete(entry)
    }
  }
  const value = sessions.get(key)
  if (!value || claims.has(key)) return undefined
  claims.add(key)
  return value
}

const claims = new Set()

function release(key) {
  claims.delete(key)
}

function forget(key) {
  sessions.delete(key)
  claims.delete(key)
}

function remember(key, threadId, sequence, bounded, sentTokens) {
  while (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
  sessions.set(key, { threadId, sequence, bounded, sentTokens, at: Date.now() })
}

function threadTurnTokens(sentTokens, incoming) {
  if (!Number.isSafeInteger(sentTokens) || sentTokens < 0) return undefined
  const projected = sentTokens + tokenCount(incoming)
  return projected <= THREAD_TOKEN_BUDGET ? projected : undefined
}

function takeMatching(messages, accountId) {
  const incoming = messages.at(-1)?.content
  for (let count = messages.length; count > 0; count--) {
    const key = digest([accountId, messages.slice(0, count)])
    const value = sessions.get(key)
    if (!value?.bounded) continue
    if (!Number.isSafeInteger(value.sentTokens) || value.sentTokens < 0) {
      sessions.delete(key)
      claims.delete(key)
      continue
    }
    if (threadTurnTokens(value.sentTokens, incoming) === undefined || claims.has(key)) continue
    claims.add(key)
    return { key, value }
  }
  return undefined
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
  // A bucket is only skipped when the vendor left it unreadable: a window that
  // does not read falls back to the allowance below it, and one that does reads
  // even when the other does not.
  const windows = [
    (data.window ? rollingWindow(data.window, data.resetsInSeconds) : undefined) ?? rollingWindow(resolved.find((entry) => entry.cadence === "rolling"), data.resetsInSeconds),
    (data.billingPeriodWindow ? billingWindow(data.billingPeriodWindow) : undefined) ?? billingWindow(resolved.find((entry) => entry.cadence === "billing_period")),
  ].filter(Boolean)
  if (windows.length) return windows
  // Buckets the vendor itself marked unexposed are an understood answer - it
  // names what it will not show. Anything else that reads no window is an
  // unreadable response, which is an error to show, never an empty account.
  const withheld = Array.isArray(data.allowances) && data.allowances.length > 0 && data.allowances.every((entry) => entry?.state === "not_exposed")
  return withheld ? [] : undefined
}

const quotaError = (error) =>
  error instanceof ProviderError ? error.message : "The Notion AI quota could not be read."

function transcriptPage(body) {
  if (body?.type !== "agent_service_transcript_page" || !Array.isArray(body.patches)) throw new ProviderError(502, "invalid_transcript", "Notion AI returned an unsupported transcript page.")
  return body
}

function crossedBoundary(page, afterSequence) {
  return afterSequence > 0 && page.patches.some((patch) => {
    const sequence = patch.op === "put" ? patch.entity?.sequence : undefined
    return Number.isSafeInteger(sequence) && sequence <= afterSequence
  })
}

async function transcriptPages(account, threadId, afterSequence, signal) {
  const latest = transcriptPage(await json("getThreadTranscript", { spaceId: account.spaceId, threadId, direction: "backward", limit: 10 }, account, signal))
  if (crossedBoundary(latest, afterSequence)) return [latest]
  const pages = [latest]
  const seen = new Set()
  let page = latest
  for (let count = 0; count < MAX_BACKWARD_PAGES; count++) {
    const cursor = page.backward_cursor
    if (typeof cursor !== "string" || !cursor || page.has_more_backward === false || seen.has(cursor)) break
    seen.add(cursor)
    page = transcriptPage(await json("getThreadTranscript", { spaceId: account.spaceId, threadId, direction: "backward", cursor, limit: 10 }, account, signal))
    pages.unshift(page)
    if (crossedBoundary(page, afterSequence)) break
  }
  return pages
}

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
    const entries = await catalog(account, signal, true)
    return Object.fromEntries(entries.map((entry) => [entry.model, modelEntry(entry)]))
  },
  async open({ auth, chat, signal }) {
    const last = chat.messages?.at(-1)
    if (!last || last.role !== "user") throw new ProviderError(400, "user_message_required", "The conversation must end with a user message.")
    // Preflight the bounded transcript before auth/workspace/catalog access so
    // an oversized latest message cannot consume a cached continuation.
    const plan = contextPlan(chat.messages)
    const account = await accountOf(auth, signal)
    const models = await catalog(account, signal)
    const model = models.find((entry) => entry.model === chat.model)
    if (!model) throw new ProviderError(403, "model_unavailable", "This Notion workspace does not offer the requested model for personal agents. Refresh the model list after signing in.")
    const effort = chat.reasoning_effort ?? model.modelConfiguration?.defaultReasoningEffort
    if (effort !== undefined && !model.modelConfiguration?.supportedReasoningEfforts?.includes(effort)) {
      throw new ProviderError(400, "reasoning_effort_unavailable", "The requested reasoning effort is not offered for this Notion model.")
    }
    const accountId = digest([account.cookie, account.spaceId, account.activeUserId, chat.model, effort])
    const historyKey = (messages) => digest([accountId, messages])
    const previousKey = historyKey(chat.messages.slice(0, -1))
    // Once the complete client history is over budget, do not grow an old
    // Notion thread. Rebuild a bounded recent window in a fresh thread; later
    // oversized turns can slide that window and roll over again safely.
    let previous = take(previousKey)
    let previousEntryKey = previousKey
    let continuedTokens
    if (previous && !Number.isSafeInteger(previous.sentTokens)) {
      forget(previousEntryKey)
      previous = undefined
    }
    if (previous) {
      continuedTokens = threadTurnTokens(previous.sentTokens, last.content)
      if (continuedTokens === undefined) {
        // The remote thread is at its cumulative budget. Never probe or send to
        // it first: rebuild from the bounded client history in a fresh thread.
        forget(previousEntryKey)
        previous = undefined
      }
    }
    if (plan.fullOverBudget) {
      if (previous && !previous.bounded) {
        release(previousEntryKey)
        previous = undefined
        continuedTokens = undefined
      }
      if (!previous) {
        const boundedPrevious = takeMatching(chat.messages, accountId)
        previous = boundedPrevious?.value
        if (boundedPrevious) {
          previousEntryKey = boundedPrevious.key
          continuedTokens = threadTurnTokens(previous.sentTokens, last.content)
        }
      }
    }
    let claimedKey = previous ? previousEntryKey : undefined
    let bounded = previous?.bounded ?? plan.fullOverBudget
    let sentTokens = previous ? continuedTokens : plan.estimated.tokens + TURN_OVERHEAD_TOKENS
    let afterSequence = 0
    if (previous) {
      try {
        const before = await json("getThreadTranscript", { spaceId: account.spaceId, threadId: previous.threadId, direction: "backward", limit: 10 }, account, signal)
        // If the user advanced this thread in Notion, the client's history is
        // no longer its history. Start a new thread instead of mixing them.
        if (before.session?.sequence !== previous.sequence) {
          forget(previousEntryKey)
          claimedKey = undefined
          previous = undefined
        } else if (before.session?.status !== "idle") {
          release(previousEntryKey)
          claimedKey = undefined
          previous = undefined
        } else {
          afterSequence = previous.sequence
          await json("sendEventToAgentThread", { spaceId: account.spaceId, threadId: previous.threadId, event: { type: "user.message", content: content(last.content) }, surface: "full_page_chat", clientEventId: randomUUID() }, account, signal)
          forget(previousEntryKey)
          claimedKey = undefined
        }
      } catch (error) {
        if (claimedKey) release(claimedKey)
        throw error
      }
    }
    let threadId
    if (previous) {
      threadId = previous.threadId
    } else {
      threadId = randomUUID()
      const created = await json("createAgentThread", {
        type: "personal_agent", spaceId: account.spaceId, threadId,
        model: chat.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        createdSource: "full_page_chat", content: content(plan.text),
        policies: { approval_mode: "ask", disable_internet_access: true, disable_computer_file_downloads: true },
        agentMemorySettings: { useMemories: false, excludeChatFromMemories: true },
        browserEnabled: false, clientMessageId: randomUUID(),
      }, account, signal)
      if (typeof created.threadId !== "string" || !UUID.test(created.threadId)) throw new ProviderError(502, "unexpected_thread", "Notion AI returned an invalid thread id.")
      threadId = created.threadId
      bounded = plan.fullOverBudget
      sentTokens = plan.estimated.tokens + TURN_OVERHEAD_TOKENS
    }
    const pages = await transcriptPages(account, threadId, afterSequence, signal)
    const newest = pages.at(-1)
    const page = pages.length === 1 ? newest : { ...newest, patches: pages.flatMap((entry) => entry.patches) }
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
          else if (event.type === "done") {
            const completedTokens = sentTokens + tokenCount(answer)
            remember(historyKey([...chat.messages, { role: "assistant", content: answer }]), threadId, event.sequence, bounded, completedTokens)
          }
          yield event
        }
      } finally { await liveResponse?.body?.cancel().catch(() => {}) }
    })()
  },
  usage: quota,
}

export const _internal = {
  cookie,
  credentials,
  accountOf,
  workspace,
  resolved,
  RESOLVED_TTL,
  keepModels,
  initialText,
  contextPlan,
  estimateTokens,
  tokenCount,
  utf8Bytes,
  transcriptText,
  content,
  sessions,
  catalogs,
  eligible,
  modelEntry,
  threadTurnTokens,
  percent,
  rollingWindow,
  billingWindow,
  quotaWindows,
  useFetch,
  CONTEXT_BUDGET,
  THREAD_TOKEN_BUDGET,
  TURN_OVERHEAD_TOKENS,
  MAX_INPUT_BYTES,
  OUTPUT_BUDGET,
}
