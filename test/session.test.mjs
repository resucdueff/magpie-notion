import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlugin } from "../core.mjs"
import protocol from "../protocol.mjs"
import { SessionError, browserStores, cookieHeader, copyToTemporary, decryptValue, findDevtoolsSession, findSession, _internal } from "../session.mjs"

const UUID = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
const realFetch = globalThis.fetch

let sqlite
try { sqlite = (await import("bun:sqlite")).Database } catch { sqlite = undefined }

const gcmSeal = (value, key, prefix = "v10") => {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()])
  return Buffer.concat([Buffer.from(prefix, "latin1"), nonce, body, cipher.getAuthTag()])
}

const cbcSeal = (value, key, prefix = "v10") => {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "))
  return Buffer.concat([Buffer.from(prefix, "latin1"), cipher.update(String(value), "utf8"), cipher.final()])
}

const capture = (fn) => { try { fn() } catch (error) { return error } }
const captureAsync = async (fn) => { try { await fn() } catch (error) { return error } }
const database = (rows) => ({ query: () => ({ all: () => rows }), close: () => {} })
const firefox = (profile, db) => ({ kind: "firefox", browser: "Firefox", profile, db })
const temporary = { copyStore: (store) => ({ path: store.db, remove: () => {} }) }
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("magpie-notion-"))
// Windows can hold a database that was just closed for a moment, so a
// temporary directory is removed with a few retries.
const remove = (directory) => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
// bun:sqlite keeps a file that was written to open past close() until it is
// collected, so a fixture is only removable once it has been collected.
const close = (connection) => { connection.close(); try { Bun.gc(true); Bun.gc(true) } catch { /* not bun */ } }

// `protect` seals a key the way Windows keeps a profile's cookie key, with the
// mirrored DPAPI call, run the way the plugin runs its own.
async function protect(key) {
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${key.toString("base64")}'),$null,'CurrentUser'))`
  return Buffer.from(String(await _internal.runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { input: script, windowsHide: true })).trim(), "base64")
}

// The writes run in a frame of their own: bun keeps a database it wrote to
// open until nothing from that connection is left, and a statement still in
// scope is enough to keep the file locked.
function writeFixture(db, rows, key) {
  const connection = new sqlite(db)
  connection.run("CREATE TABLE cookies (name TEXT, encrypted_value BLOB, host_key TEXT)")
  for (const [name, value, host] of rows) connection.prepare("INSERT INTO cookies (name, encrypted_value, host_key) VALUES (?, ?, ?)").run(name, gcmSeal(value, key), host)
  connection.close()
}

function windowsStore(directory, rows, key) {
  const db = join(directory, "Cookies")
  writeFixture(db, rows, key)
  try { Bun.gc(true) } catch { /* not bun */ }
  return { kind: "chromium", browser: "Chrome", profile: "Default", db, localState: join(directory, "Local State") }
}

// Windows keeps the profile's cookie key as base64("DPAPI" + the sealed key).
function writeLocalState(localState, sealed) {
  writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), sealed]).toString("base64") } }))
}

test("the roots name the browsers of each platform, most likely first", () => {
  const windows = _internal.chromiumRoots("win32", { LOCALAPPDATA: "L" }, "H")
  expect(windows.map((store) => store.browser)).toEqual(["Chrome", "Edge", "Brave", "Chromium"])
  expect(windows[0].root).toBe(join("L", "Google", "Chrome", "User Data"))
  expect(_internal.chromiumRoots("darwin", {}, "/Users/x")[0].root).toContain(join("Library", "Application Support"))
  expect(_internal.chromiumRoots("linux", {}, "/home/x").map((store) => store.browser)).toContain("Chromium")
  expect(_internal.firefoxRoots("linux", { XDG_CONFIG_HOME: "/c" }, "/h").map((store) => store.root)).toEqual([join("/h", ".mozilla", "firefox"), join("/c", "mozilla", "firefox")])
  expect(_internal.firefoxRoots("win32", { APPDATA: "R" }, "H")[0].root).toBe(join("R", "Mozilla", "Firefox", "Profiles"))
})

test("browserStores lists the profiles a browser names, in the layout each one uses", () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-stores-"))
  try {
    const local = join(home, "AppData", "Local")
    const roaming = join(home, "AppData", "Roaming")
    const root = join(local, "Google", "Chrome", "User Data")
    mkdirSync(join(root, "Profile 2", "Network"), { recursive: true })
    writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": {} } } }))
    writeFileSync(join(root, "Profile 2", "Network", "Cookies"), "not a database")
    const profile = join(roaming, "Mozilla", "Firefox", "Profiles", "abc.default")
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, "cookies.sqlite"), "not a database")
    const stores = browserStores({ platform: "win32", home, env: { LOCALAPPDATA: local, APPDATA: roaming } })
    expect(stores.find((store) => store.browser === "Chrome")).toMatchObject({ kind: "chromium", profile: "Profile 2", db: join(root, "Profile 2", "Network", "Cookies") })
    expect(stores.find((store) => store.browser === "Firefox")).toMatchObject({ kind: "firefox", profile: "abc.default" })
  } finally {
    remove(home)
  }
})

test("cookieHeader joins the session's cookies once, in the order they were found", () => {
  expect(cookieHeader([{ name: "token_v2", value: "a" }, { name: "notion_user_id", value: "u" }, { name: "token_v2", value: "a" }, { name: "", value: "x" }, { name: "empty", value: "" }])).toBe("token_v2=a; notion_user_id=u")
  expect(cookieHeader([])).toBe("")
})

test("a v10 value is opened the way Windows writes it, with AES-256-GCM", () => {
  const key = randomBytes(32)
  expect(decryptValue(gcmSeal("session-secret", key), { cipher: "gcm", key }, { platform: "win32" })).toBe("session-secret")
  expect(decryptValue(gcmSeal("unicode-\u4e2d\u6587", key), { cipher: "gcm", key })).toBe("unicode-\u4e2d\u6587")
})

test("a v11 value and a value from a keychain build both open", () => {
  const key = randomBytes(32)
  expect(decryptValue(gcmSeal("eleven", key, "v11"), { cipher: "gcm", key }, { platform: "win32" })).toBe("eleven")
  const secret = "desktop-password"
  const derived = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1")
  expect(decryptValue(cbcSeal("desktop-session", derived), { cipher: "cbc", key: derived }, { platform: "darwin" })).toBe("desktop-session")
})

test("an empty value is nothing, never a failure", () => {
  expect(decryptValue(Buffer.alloc(0), undefined)).toBe("")
  expect(decryptValue(undefined, undefined)).toBe("")
})

test("a v20 value is reported for the fallback, never guessed", () => {
  const error = capture(() => decryptValue(Buffer.concat([Buffer.from("v20"), randomBytes(48)]), { cipher: "gcm", key: randomBytes(32) }, { platform: "win32" }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.reason).toBe("unsupported-encryption")
  expect(error.message).toContain("v20")
  expect(error.message).toContain("paste the Cookie header")
})

test("a value with no version marker is reported instead of guessed at", () => {
  const error = capture(() => decryptValue(Buffer.from("abcdefghijklmnop"), { cipher: "gcm", key: randomBytes(32) }, { platform: "win32" }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.reason).toBe("unsupported-encryption")
})

test("a truncated or tampered value is refused", () => {
  const key = randomBytes(32)
  expect(capture(() => decryptValue(Buffer.from("v10short"), { cipher: "gcm", key }, { platform: "win32" })).message).toContain("too short")
  const sealed = gcmSeal("session-secret", key)
  sealed[sealed.length - 1] ^= 0xff
  const error = capture(() => decryptValue(sealed, { cipher: "gcm", key }, { platform: "win32" }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.message).toContain("could not be unsealed")
})

test("a profile whose cookie key is missing or not DPAPI is reported, not used", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-keystate-"))
  try {
    const localState = join(directory, "Local State")
    writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("not-dpapi-key").toString("base64") } }))
    const notDpapi = await captureAsync(() => _internal.valueKey({ browser: "Chrome", localState }, { platform: "win32" }))
    expect(notDpapi).toBeInstanceOf(SessionError)
    expect(notDpapi.reason).toBe("unsupported-encryption")
    expect(notDpapi.message).toContain("not DPAPI")
    const empty = join(directory, "empty state")
    writeFileSync(empty, "{}")
    expect((await captureAsync(() => _internal.valueKey({ browser: "Chrome", localState: empty }, { platform: "win32" }))).message).toContain("holds no cookie key")
    // Windows takes its key from Local State; a desktop's comes from the keychain,
    // where a refusal is reported instead of being used as a key.
    expect(await captureAsync(() => _internal.valueKey({ browser: "Chrome", localState }, { platform: "darwin", run: async () => { throw new Error("no keychain") } }))).toBeInstanceOf(SessionError)
  } finally {
    remove(directory)
  }
})

test("a locked store is reported in the words a user can act on", () => {
  const error = capture(() => copyToTemporary({ browser: "Chrome", db: "x" }, { copyFile: () => { const failure = new Error("EBUSY: resource busy or locked"); failure.code = "EBUSY"; throw failure } }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.reason).toBe("locked")
  expect(error.message).toContain("close Chrome")
  for (const code of ["EPERM", "EACCES"]) {
    const denied = capture(() => copyToTemporary({ browser: "Edge", db: "x" }, { copyFile: () => { const failure = new Error("denied"); failure.code = code; throw failure } }))
    expect(denied.reason).toBe("locked")
  }
})

test("a store that cannot be copied leaves no directory behind", () => {
  const before = leftovers().length
  expect(capture(() => copyToTemporary({ browser: "Chrome", db: "x" }, { copyFile: () => { const failure = new Error("nope"); failure.code = "EIO"; throw failure } })).reason).toBe("unreadable")
  expect(capture(() => copyToTemporary({ browser: "Chrome", db: join(tmpdir(), "magpie-missing-" + randomBytes(4).toString("hex")) })).reason).toBe("unreadable")
  expect(leftovers().length).toBe(before)
})

test("findSession answers with the session of the first store that has one", async () => {
  const rows = {
    first: [{ name: "token_v2", value: "", host: ".notion.so" }],
    second: [
      { name: "token_v2", value: "session-secret", host: ".notion.so" },
      { name: "notion_user_id", value: USER, host: "app.notion.com" },
      { name: "token_v2", value: "another-site", host: "notion.example.com" },
      { name: "notion_os", value: "win", host: "www.notion.so" },
    ],
  }
  const found = await findSession({ ...temporary, stores: [firefox("one.default", "first"), firefox("two.default", "second")], openDatabase: (path) => database(rows[path]) })
  expect(found).toEqual({ cookie: `token_v2=session-secret; notion_user_id=${USER}; notion_os=win`, browser: "Firefox", profile: "two.default", activeUserId: USER })
})

test("findSession says why every store it looked at was left out", async () => {
  const stores = [firefox("one.default", "empty"), firefox("two.default", "broken")]
  const error = await captureAsync(() => findSession({ ...temporary, stores, openDatabase: (path) => path === "empty" ? database([]) : { query: () => { throw new Error("table moz_cookies has no column named value") }, close: () => {} } }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.reason).toBe("no-session")
  expect(error.message).toContain("Firefox (one.default) has no Notion session")
  expect(error.message).toContain("Firefox (two.default): could not be read")
  expect(error.message).not.toContain("no column named")
})

test("findSession keeps the reason a locked store gives, and reports no browser at all", async () => {
  const locked = new SessionError("Chrome is running and holds its cookie store open; close Chrome and sign in again", "locked")
  const error = await captureAsync(() => findSession({ stores: [firefox("one.default", "x")], copyStore: () => { throw locked } }))
  expect(error.reason).toBe("no-session")
  expect(error.message).toContain("close Chrome")
  const none = await captureAsync(() => findSession({ stores: [] }))
  expect(none.reason).toBe("no-browser")
  expect(none.message).toContain("No Chrome, Edge, Brave, Chromium or Firefox profile")
})

test("a cookie's domain counts when it is Notion's own or below it", () => {
  for (const domain of ["notion.so", ".notion.so", "www.notion.so", ".app.notion.com", "app.notion.com", ".notion.com", "notion.com", "www.notion.com"]) {
    expect(_internal.notionHost(domain)).toBe(true)
  }
  for (const domain of ["example.com", "notion.so.example.com", "mynotion.so", "", undefined, null, "eviltonotion.com"]) {
    expect(_internal.notionHost(domain)).toBe(false)
  }
})

test("a profile that is running names its debugging port, and one that is not names nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-port-"))
  try {
    const root = join(home, "Root")
    mkdirSync(root)
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/9aa60052-e2ea-4127-b4cc-84a58e813c97\n")
    expect(_internal.devtoolsEndpoint({ root })).toBe("ws://127.0.0.1:9222/devtools/browser/9aa60052-e2ea-4127-b4cc-84a58e813c97")
    writeFileSync(join(root, "DevToolsActivePort"), "not a port\n")
    expect(_internal.devtoolsEndpoint({ root })).toBeUndefined()
    expect(_internal.devtoolsEndpoint({ root: join(home, "Missing") })).toBeUndefined()
  } finally {
    remove(home)
  }
})

test("a running browser is asked for its own cookies when its store cannot be read", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-live-"))
  try {
    const root = join(home, "Root")
    mkdirSync(root)
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/token\n")
    const store = { kind: "chromium", browser: "Chrome", profile: "Default", root, db: join(root, "Cookies"), localState: join(root, "Local State") }
    // The domains are the ones a real Chrome answers with: the session cookie
    // sits on .app.notion.com, dotted, which an exact-host list misses.
    const cookies = [
      { name: "token_v2", value: "browser-session", domain: ".app.notion.com" },
      { name: "notion_user_id", value: USER, domain: ".app.notion.com" },
      { name: "token_v2", value: "another-site", domain: "example.com" },
      { name: "tracking", value: "no", domain: ".notion.so" },
    ]
    const asked = []
    const found = await findDevtoolsSession({ stores: [store], connect: async (endpoint) => { asked.push(endpoint); return cookies } })
    expect(asked).toEqual(["ws://127.0.0.1:9222/devtools/browser/token"])
    expect(found).toEqual({ cookie: `token_v2=browser-session; notion_user_id=${USER}`, browser: "Chrome", profile: "Default", via: "devtools", activeUserId: USER })
    // and findSession itself falls back to it when the store is held open
    const locked = await findSession({ stores: [store], copyStore: () => { throw new SessionError("Chrome is running and holds its cookie store open; close Chrome and sign in again", "locked") }, connect: async () => cookies }).catch((error) => error)
    expect(locked.cookie).toContain("token_v2=browser-session")
    // one answer per browser, named for the profile the browser answers for
    const twice = []
    const twoProfiles = [store, { ...store, profile: "Profile 1" }]
    expect(await findDevtoolsSession({ stores: twoProfiles, connect: async (endpoint) => { twice.push(endpoint); return cookies } })).toMatchObject({ profile: "Default" })
    expect(twice).toHaveLength(1)
  } finally {
    remove(home)
  }
})

test("a debugging port that says nothing useful is not mistaken for a session", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-quiet-"))
  try {
    const root = join(home, "Root")
    mkdirSync(root)
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/token\n")
    const store = { kind: "chromium", browser: "Chrome", profile: "Default", root, db: join(root, "Cookies"), localState: join(root, "Local State") }
    const quiet = await captureAsync(() => findDevtoolsSession({ stores: [store], connect: async () => [{ name: "token_v2", value: "another-site", domain: "example.com" }] }))
    expect(quiet).toBeInstanceOf(SessionError)
    expect(quiet.message).toContain("signed in to no Notion account")
    const refused = await captureAsync(() => findDevtoolsSession({ stores: [store], connect: async () => { throw new SessionError("the browser's debugging port refused the read", "devtools") } }))
    expect(refused.reason).toBe("no-session")
    expect(refused.message).toContain("refused the read")
    // a machine with no debugging port at all stays quiet about it
    expect(await findDevtoolsSession({ stores: [{ ...store, root: join(home, "None") }] })).toBeUndefined()
  } finally {
    remove(home)
  }
})

test("a read that times out is tried once more, and a refusal is not", async () => {
  const real = globalThis.WebSocket
  const attempts = []
  class FakeWebSocket {
    constructor(endpoint) {
      this.listeners = {}
      attempts.push(endpoint)
      const first = attempts.length === 1
      Promise.resolve().then(() => {
        this.emit("open")
        if (!first) Promise.resolve().then(() => this.emit("message", { data: JSON.stringify({ id: 1, result: { cookies: [{ name: "token_v2", value: "second-try", domain: ".app.notion.com" }] } }) }))
      })
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    emit(type, event = {}) { for (const handler of this.listeners[type] ?? []) handler(event) }
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket
  try {
    expect(await _internal.connectDevtools("ws://127.0.0.1:9222/devtools/browser/token", 20)).toEqual([{ name: "token_v2", value: "second-try", domain: ".app.notion.com" }])
    expect(attempts).toHaveLength(2)
    // a port that refuses the read is answering, so it is believed the first time
    class RefusingWebSocket extends FakeWebSocket {
      constructor(endpoint) {
        super(endpoint)
        Promise.resolve().then(() => this.emit("error", {}))
      }
    }
    globalThis.WebSocket = RefusingWebSocket
    attempts.length = 0
    const refused = await captureAsync(() => _internal.connectDevtools("ws://127.0.0.1:9222/devtools/browser/token", 20))
    expect(refused).toBeInstanceOf(SessionError)
    expect(refused.reason).toBe("devtools")
    expect(attempts).toHaveLength(1)
  } finally {
    globalThis.WebSocket = real
  }
})

test("the browser sign-in takes the session that is there, asking nothing", async () => {
  const session = { findSession: async () => ({ cookie: `token_v2=live-session; notion_user_id=${USER}`, browser: "Edge", profile: "Default", activeUserId: USER }) }
  const plugin = createPlugin(protocol, { session })
  const method = plugin.auth.methods.find((entry) => entry.type === "oauth")
  expect(method.label).toBe("Use the Notion session in this browser")
  const start = await method.authorize()
  expect(start).toMatchObject({ url: "", method: "auto" })
  expect(typeof start.callback).toBe("function")
  expect(await start.callback()).toEqual({ type: "success", key: `token_v2=live-session; notion_user_id=${USER}`, metadata: { browser: "Edge", profile: "Default", activeUserId: USER } })
})

test("a store this build cannot open fails the sign-in with the reason, not a generic error", async () => {
  const session = { findSession: async () => { throw new SessionError("Chrome (Default): this store's cookies are bound to the browser (v20); paste the Cookie header instead", "unsupported-encryption") } }
  const plugin = createPlugin(protocol, { session })
  const result = await (await plugin.auth.methods.find((entry) => entry.type === "oauth").authorize()).callback()
  expect(result.type).toBe("failed")
  expect(result.error).toContain("v20")
  expect(result.error).toContain("paste the Cookie header")
})

test("the manual method asks for the session only, and a blank workspace is allowed", async () => {
  const plugin = createPlugin(protocol, {})
  const manual = plugin.auth.methods.find((entry) => entry.type === "api")
  expect(manual.prompts.filter((prompt) => prompt.key === "spaceId").every((prompt) => prompt.validate("") === undefined)).toBe(true)
  expect(manual.prompts.find((prompt) => prompt.key === "spaceId").validate("not-a-uuid")).toBeString()
  expect(manual.prompts.find((prompt) => prompt.key === "activeUserId").validate("")).toBeUndefined()
  expect(manual.prompts.find((prompt) => prompt.key === "activeUserId").validate("nope")).toBeString()
  expect(manual.prompts.every((prompt) => prompt.type === "text")).toBe(true)
})

function mockNotion(handle) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    calls.push({ name, data: JSON.parse(init.body), init })
    if (handle) { const custom = await handle(name, calls); if (custom) return custom }
    if (name === "authValidate") return Response.json({})
    if (name === "getAvailableModels") return Response.json({ models: [{ model: "test-model", modelMessage: "Test", agentService: {}, modelConfiguration: {} }] })
    if (name === "createAgentThread") return Response.json({ threadId: "33333333-3333-4333-8333-333333333333" })
    if (name === "getThreadTranscript") return Response.json({ type: "agent_service_transcript_page", patches: [], session: { sequence: 0, status: "running" }, forward_cursor: "cursor" })
    if (name === "listenToThreadTranscript") return new Response(JSON.stringify({ op: "put", entity: { id: "done", kind: "turn_completed", sequence: 1, stop_reason: "end_turn" } }) + "\n")
    throw new Error("Unexpected offline endpoint " + name)
  }
  return { calls }
}

async function chat(plugin, auth) {
  const loader = await plugin.auth.loader(async () => auth)
  return loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "Hello" }] }) })
}

test("a request reads the browser again, and the saved session is the fallback", async () => {
  const mock = mockNotion()
  let reads = 0
  const session = { findSession: async () => { reads++; return reads === 1 ? { cookie: "token_v2=live-one", browser: "Chrome", profile: "Default" } : (() => { throw new SessionError("Chrome is not running", "locked") })() } }
  const plugin = createPlugin(protocol, { session, browserReadMs: 0 })
  const kept = { type: "api", key: "token_v2=kept", metadata: { browser: "Chrome", profile: "Default", spaceId: UUID } }
  expect((await chat(plugin, kept)).status).toBe(200)
  expect((await chat(plugin, kept)).status).toBe(200)
  expect(reads).toBe(2)
  expect(mock.calls.filter((call) => call.name === "createAgentThread").map((call) => call.init.headers.Cookie)).toEqual(["token_v2=live-one", "token_v2=kept"])
  globalThis.fetch = realFetch
})

test("a burst of requests reuses one browser read, and an unauthorized answer drops it", async () => {
  let reads = 0
  let expired = false
  const mock = mockNotion((name) => (name === "createAgentThread" && expired ? Response.json({ message: "session expired" }, { status: 401 }) : undefined))
  const session = { findSession: async () => { reads++; return { cookie: "token_v2=live", browser: "Chrome", profile: "Default" } } }
  const plugin = createPlugin(protocol, { session })
  const kept = { type: "api", key: "token_v2=kept", metadata: { browser: "Chrome", profile: "Default", spaceId: UUID } }
  expect((await chat(plugin, kept)).status).toBe(200)
  expect((await chat(plugin, kept)).status).toBe(200)
  expect(reads).toBe(1)
  expect(mock.calls.filter((call) => call.name === "createAgentThread").map((call) => call.init.headers.Cookie)).toEqual(["token_v2=live", "token_v2=live"])
  expired = true
  expect((await chat(plugin, kept)).status).toBe(401)
  expect(reads).toBe(1)
  expired = false
  expect((await chat(plugin, kept)).status).toBe(200)
  expect(reads).toBe(2)
  globalThis.fetch = realFetch
})

test("a session that was pasted by hand never reads a browser", async () => {
  const mock = mockNotion()
  const session = { findSession: async () => { throw new Error("a browser must not be read") } }
  const plugin = createPlugin(protocol, { session })
  const auth = { type: "api", key: "token_v2=by-hand", metadata: { spaceId: UUID, activeUserId: USER } }
  expect((await chat(plugin, auth)).status).toBe(200)
  expect(new Set(mock.calls.map((call) => call.init.headers.Cookie))).toEqual(new Set(["token_v2=by-hand"]))
  globalThis.fetch = realFetch
})

test.skipIf(!sqlite || process.platform !== "win32")("the Windows path reads a real DPAPI-sealed store end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-dpapi-"))
  try {
    const key = randomBytes(32)
    const store = windowsStore(directory, [["token_v2", "e2e-session-token", ".notion.so"], ["notion_user_id", USER, "www.notion.so"], ["token_v2", "other-site", "example.com"]], key)
    writeLocalState(store.localState, await protect(key))
    const found = await findSession({ platform: "win32", stores: [store] })
    expect(found).toEqual({ cookie: `token_v2=e2e-session-token; notion_user_id=${USER}`, browser: "Chrome", profile: "Default", activeUserId: USER })
  } finally {
    remove(directory)
  }
})

test.skipIf(!sqlite || process.platform !== "win32")("a v20 store is reported with the reason and the way out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-v20-"))
  try {
    const key = randomBytes(32)
    const store = windowsStore(directory, [], key)
    const connection = new sqlite(store.db)
    connection.prepare("INSERT INTO cookies (name, encrypted_value, host_key) VALUES (?, ?, ?)").run("token_v2", Buffer.concat([Buffer.from("v20"), randomBytes(48)]), ".notion.so")
    close(connection)
    writeLocalState(store.localState, await protect(key))
    const error = await captureAsync(() => findSession({ platform: "win32", stores: [store] }))
    expect(error).toBeInstanceOf(SessionError)
    expect(error.reason).toBe("no-session")
    expect(error.message).toContain("v20")
    expect(error.message).toContain("paste the Cookie header")
  } finally {
    remove(directory)
  }
})
