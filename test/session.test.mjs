import { afterEach, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { createPlugin } from "../core.mjs"
import protocol, { _internal as protocolInternals } from "../protocol.mjs"
import { SessionError, bestCookies, browserStores, cookieHeader, copyToTemporary, decryptValue, findDevtoolsSession, findSession, _internal } from "../session.mjs"

const UUID = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const cookieValue = (header, name) => header.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1)

let sqlite
try { sqlite = (await import("bun:sqlite")).Database } catch { sqlite = undefined }

// The real-runtime test below needs a Node that ships node:sqlite without a
// flag. It is probed once here so the test can be skipped, not failed, on a
// machine whose node is older than that.
const nodeRuntime = await new Promise((resolve) => {
  execFile("node", ["--input-type=module", "-e", "import('node:sqlite').then(() => process.stdout.write(process.versions.node))"], { windowsHide: true, timeout: 15_000 }, (error, stdout) => resolve(error ? undefined : String(stdout).trim()))
})

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
  const linux = _internal.chromiumRoots("linux", {}, "/home/x").map((store) => store.root)
  expect(linux).toContain(join("/home/x", ".config", "chromium"))
  // Flatpak and Snap keep their profiles outside the configuration directory.
  expect(linux).toContain(join("/home/x", ".var", "app", "com.google.Chrome", "config", "google-chrome"))
  expect(linux).toContain(join("/home/x", "snap", "chromium", "current", ".config", "chromium"))
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

test("cookieHeader keeps one value per name, from the domain the web client serves", () => {
  const cookies = [
    { name: "token_v2", value: "personal-site", host: "www.notion.so" },
    { name: "notion_user_id", value: "u1", host: "www.notion.so" },
    { name: "token_v2", value: "workspace-site", host: ".app.notion.com" },
    { name: "notion_user_id", value: "u2", host: "app.notion.com" },
  ]
  expect(cookieHeader(cookies)).toBe("token_v2=workspace-site; notion_user_id=u2")
  // A devtools answer names the same field "domain", not "host".
  expect(bestCookies([{ name: "token_v2", value: "old", domain: "notion.so" }, { name: "token_v2", value: "new", domain: ".app.notion.com" }])).toEqual([{ name: "token_v2", value: "new", domain: ".app.notion.com" }])
})

test("findSession prefers the workspace session over an older personal one", async () => {
  const rows = [
    { name: "token_v2", value: "personal-site", host: "www.notion.so" },
    { name: "token_v2", value: "workspace-site", host: ".app.notion.com" },
    { name: "notion_user_id", value: USER, host: ".app.notion.com" },
  ]
  const found = await findSession({ ...temporary, stores: [firefox("one.default", "db")], openDatabase: () => database(rows) })
  expect(found.cookie).toBe(`token_v2=workspace-site; notion_user_id=${USER}`)
  expect(found.activeUserId).toBe(USER)
})

test("browserStores puts the profile the browser last used first", () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-lastused-"))
  try {
    const local = join(home, "AppData", "Local")
    const root = join(local, "Google", "Chrome", "User Data")
    for (const profile of ["Default", "Profile 2"]) {
      mkdirSync(join(root, profile, "Network"), { recursive: true })
      writeFileSync(join(root, profile, "Network", "Cookies"), "not a database")
    }
    writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {}, "Profile 2": {} }, last_used: "Profile 2" } }))
    const stores = browserStores({ platform: "win32", home, env: { LOCALAPPDATA: local } })
    expect(stores.map((store) => store.profile)).toEqual(["Profile 2", "Default"])
  } finally {
    remove(home)
  }
})

test("one row this build cannot open does not sink the session beside it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-rows-"))
  try {
    const key = randomBytes(32)
    const localState = join(directory, "Local State")
    writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const rows = [
      { name: "token_v2", encrypted_value: gcmSeal("session-secret", key), host: ".notion.so" },
      { name: "notion_os", encrypted_value: Buffer.concat([Buffer.from("v20"), randomBytes(48)]), host: ".notion.so" },
    ]
    const store = { kind: "chromium", browser: "Chrome", profile: "Default", db: "unused", localState }
    // The DPAPI unwrap is answered offline; the v20 row is what this build
    // cannot open, and only the session itself is allowed to fail the store.
    const found = await findSession({ ...temporary, stores: [store], openDatabase: () => database(rows), platform: "win32", run: async () => key.toString("base64") })
    expect(found.cookie).toBe("token_v2=session-secret")
    const denied = await captureAsync(() => findSession({ ...temporary, stores: [{ ...store, profile: "Other" }, store], openDatabase: () => database([{ name: "token_v2", encrypted_value: Buffer.concat([Buffer.from("v20"), randomBytes(48)]), host: ".notion.so" }]), platform: "win32", run: async () => key.toString("base64") }))
    expect(denied).toBeInstanceOf(SessionError)
    expect(denied.message).toContain("v20")
  } finally {
    remove(directory)
  }
})

test("the desktop keychain is asked under the name each browser files its key as", async () => {
  const asked = []
  const run = async (file, args) => { asked.push([file, ...args]); return "offline-key" }
  const mac = await _internal.valueKey({ browser: "Edge", localState: "unused" }, { platform: "darwin", run })
  expect(mac).toMatchObject({ cipher: "cbc" })
  expect(asked[0]).toEqual(["/usr/bin/security", "find-generic-password", "-w", "Microsoft Edge Safe Storage"])
  asked.length = 0
  const linux = await _internal.valueKey({ browser: "Edge", localState: "unused" }, { platform: "linux", run })
  expect(linux).toMatchObject({ cipher: "cbc" })
  expect(asked[0]).toEqual(["secret-tool", "lookup", "application", "microsoft-edge"])
})

test("a Linux basic store opens with its fixed passphrase when the sign-in service gives no value", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-basic-store-"))
  try {
    const derived = pbkdf2Sync(_internal.BASIC_STORE_PASSPHRASE, "saltysalt", 1, 16, "sha1")
    const rows = [
      { name: "token_v2", encrypted_value: cbcSeal("synthetic-session", derived), host: ".app.notion.com" },
      { name: "notion_user_id", encrypted_value: cbcSeal(USER, derived), host: ".app.notion.com" },
    ]
    const store = { kind: "chromium", browser: "Chromium", profile: "Default", db: join(directory, "Cookies"), localState: join(directory, "Local State") }
    const found = await findSession({
      ...temporary,
      platform: "linux",
      stores: [store],
      openDatabase: () => database(rows),
      run: async () => { throw new Error("no sign-in service") },
    })
    expect(found).toEqual({ cookie: `token_v2=synthetic-session; notion_user_id=${USER}`, browser: "Chromium", profile: "Default", activeUserId: USER })

    // A value this passphrase cannot open keeps the original service failure.
    const cipher = createCipheriv("aes-128-cbc", derived, Buffer.alloc(16, " "))
    cipher.setAutoPadding(false)
    const invalid = Buffer.concat([Buffer.from("v10"), cipher.update(Buffer.alloc(16)), cipher.final()])
    const denied = await captureAsync(() => findSession({
      ...temporary,
      platform: "linux",
      stores: [store],
      openDatabase: () => database([{ name: "token_v2", encrypted_value: invalid, host: ".app.notion.com" }]),
      run: async () => "",
    }))
    expect(denied).toBeInstanceOf(SessionError)
    expect(denied.reason).toBe("no-session")
    expect(denied.message).toContain("keychain did not give up")
  } finally {
    remove(directory)
  }
})

test("a readStore copy is taken back after it has been read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-copy-"))
  const before = leftovers().length
  try {
    const db = join(directory, "Cookies")
    writeFileSync(db, "not a database")
    const store = { kind: "chromium", browser: "Chrome", profile: "Default", db, localState: join(directory, "Local State") }
    const error = await captureAsync(() => findSession({ stores: [store], openDatabase: () => database([]) }))
    expect(error).toBeInstanceOf(SessionError)
    expect(error.message).toContain("has no Notion session")
  } finally {
    remove(directory)
  }
  expect(leftovers().length).toBe(before)
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
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/devtools-path\n")
    expect(_internal.devtoolsEndpoint({ root })).toBe("ws://127.0.0.1:9222/devtools/browser/devtools-path")
    writeFileSync(join(root, "DevToolsHost"), "magpie-notion-browser\n")
    expect(_internal.devtoolsEndpoint({ root })).toBe("ws://magpie-notion-browser:9222/devtools/browser/devtools-path")
    rmSync(join(root, "DevToolsHost"))
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

test("a debugging port that never opens has a short connection limit", async () => {
  const real = globalThis.WebSocket
  const attempts = []
  class HangingWebSocket {
    constructor(endpoint) {
      this.listeners = {}
      attempts.push(endpoint)
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    send() {}
    close() {}
  }
  globalThis.WebSocket = HangingWebSocket
  try {
    const started = Date.now()
    const error = await captureAsync(() => _internal.connectDevtools("ws://magpie-notion-browser:9222/devtools/browser/devtools-path", 1_000, 10))
    expect(error).toBeInstanceOf(SessionError)
    expect(error.reason).toBe("devtools-timeout")
    expect(error.message).toContain("could not be reached")
    expect(attempts).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(500)
  } finally {
    globalThis.WebSocket = real
  }
})

test("the only sign-in method is a Chinese token_v2 paste field", async () => {
  const plugin = createPlugin(protocol, {})
  expect(plugin.auth.methods).toEqual([{ type: "api", label: "粘贴 token_v2", placeholder: "只粘贴 token_v2" }])
})

function mockNotion(handle) {
  const calls = []
  protocolInternals.useFetch(async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1)
    calls.push({ name, data: JSON.parse(init.body), init })
    if (handle) { const custom = await handle(name, calls); if (custom) return custom }
    if (name === "authValidate") return Response.json({})
    if (name === "getAvailableModels") return Response.json({ models: [{ model: "test-model", modelMessage: "Test", agentService: {}, modelConfiguration: {} }] })
    if (name === "createAgentThread") return Response.json({ threadId: "33333333-3333-4333-8333-333333333333" })
    if (name === "getThreadTranscript") return Response.json({ type: "agent_service_transcript_page", patches: [], session: { sequence: 0, status: "running" }, forward_cursor: "cursor" })
    if (name === "listenToThreadTranscript") return new Response(JSON.stringify({ op: "put", entity: { id: "done", kind: "turn_completed", sequence: 1, stop_reason: "end_turn" } }) + "\n")
    throw new Error("Unexpected offline endpoint " + name)
  })
  return { calls }
}

afterEach(() => { protocolInternals.useFetch(undefined) })

async function chat(plugin, auth) {
  const loader = await plugin.auth.loader(async () => auth)
  return loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "Hello" }] }) })
}

test("the pasted token is used directly and never reads a browser", async () => {
  const mock = mockNotion()
  const plugin = createPlugin(protocol, {})
  const auth = { type: "api", key: "pasted-token-value", metadata: { spaceId: UUID, activeUserId: USER } }
  expect((await chat(plugin, auth)).status).toBe(200)
  const cookies = new Set(mock.calls.map((call) => call.init.headers.Cookie))
  expect(cookies.size).toBe(1)
  const header = cookies.values().next().value
  expect(cookieValue(header, "token_v2")).toBe(auth.key)
  expect(UUID_PATTERN.test(cookieValue(header, "device_id"))).toBe(true)
  expect(cookieValue(header, "notion_users")).toBe(encodeURIComponent(JSON.stringify([USER])))
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

test("a runtime without WebSocket says so instead of blaming the encryption", async () => {
  const real = globalThis.WebSocket
  globalThis.WebSocket = undefined
  try {
    const error = await captureAsync(() => _internal.connectDevtools("ws://127.0.0.1:9222/devtools/browser/token", 20))
    expect(error).toBeInstanceOf(SessionError)
    expect(error.reason).toBe("unsupported-runtime")
    expect(error.message).toContain("debugging port")
  } finally {
    globalThis.WebSocket = real
  }
})

test("the profile directories the environment names are taken first, and taken once", () => {
  const one = join("profiles", "one")
  const two = join("profiles", "two")
  const three = join("profiles", "three")
  // Both names take a list, separated the way the platform separates paths;
  // `two` is named twice and the blank parts are not directories at all.
  const roots = _internal.configuredRoots({
    NOTION_BROWSER_PROFILE: [one, two].join(delimiter),
    MAGPIE_NOTION_BROWSER_PROFILE: [two, three, "   ", ""].join(delimiter),
  })
  expect(roots).toEqual([
    { browser: "Chromium", root: one },
    { browser: "Chromium", root: two },
    { browser: "Chromium", root: three },
  ])
  expect(_internal.configuredRoots({})).toEqual([])
  expect(_internal.configuredRoots(undefined)).toEqual([])
})

test("a profile named in the environment is the first root on every platform", () => {
  const named = join("named", "profile")
  const platforms = [
    ["win32", { LOCALAPPDATA: "L" }, "H", join("L", "Google", "Chrome", "User Data"), ["Chrome", "Edge", "Brave", "Chromium"]],
    ["darwin", {}, "/Users/x", join("/Users/x", "Library", "Application Support", "Google", "Chrome"), ["Chrome", "Edge", "Brave", "Chromium"]],
    ["linux", { XDG_CONFIG_HOME: "/c" }, "/home/x", join("/c", "google-chrome"), ["Chrome", "Chromium", "Edge", "Brave"]],
  ]
  for (const [platform, env, home, first, following] of platforms) {
    const roots = _internal.chromiumRoots(platform, { ...env, NOTION_BROWSER_PROFILE: named }, home)
    expect(roots[0]).toEqual({ browser: "Chromium", root: named })
    // The browser the build would have read on its own still comes next.
    expect(roots[1]).toEqual({ browser: "Chrome", root: first })
    expect(roots.slice(1, 5).map((store) => store.browser)).toEqual(following)
  }
})

test("a profile that has only written its debugging port still counts as a store", () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-port-"))
  try {
    const local = join(home, "AppData", "Local")
    const root = join(local, "Google", "Chrome", "User Data")
    mkdirSync(root, { recursive: true })
    // A headless Chromium writes its port before it writes a cookie store.
    writeFileSync(join(root, "DevToolsActivePort"), `${9222}\n/devtools/browser/devtools-path\n`)
    const stores = browserStores({ platform: "win32", home, env: { LOCALAPPDATA: local } })
    const chrome = stores.filter((store) => store.browser === "Chrome")
    expect(chrome.length).toBe(1)
    expect(chrome[0].db).toBeUndefined()
    expect(chrome[0]).toMatchObject({ kind: "chromium", browser: "Chrome", profile: "Default", root })
  } finally {
    remove(home)
  }
})

test("findSession steps over a store that has no database and reads the next one", async () => {
  const portOnly = { kind: "chromium", browser: "Chrome", root: "unused", profile: "Default", db: undefined, localState: "unused" }
  const rows = [
    { name: "token_v2", value: "session-secret", host: ".notion.so" },
    { name: "notion_user_id", value: USER, host: ".notion.so" },
  ]
  const asked = []
  const found = await findSession({
    stores: [portOnly, firefox("one.default", "db")],
    copyStore: (store) => { asked.push(store.db); return { path: store.db, remove: () => {} } },
    openDatabase: () => database(rows),
  })
  // The store with no database is never handed to a copy or a connection.
  expect(asked).toEqual(["db"])
  expect(found).toEqual({ cookie: `token_v2=session-secret; notion_user_id=${USER}`, browser: "Firefox", profile: "one.default", activeUserId: USER })
})

test("readStore refuses a store that has no database, and names the reason", async () => {
  const error = await captureAsync(() => _internal.readStore({ kind: "chromium", browser: "Chrome", profile: "Default", db: undefined, root: "unused", localState: "unused" }))
  expect(error).toBeInstanceOf(SessionError)
  expect(error.reason).toBe("no-store")
})

test("a Bun store is read through query(), the way Bun's sqlite answers", () => {
  const rows = [{ name: "token_v2", host: ".notion.so" }]
  const asked = []
  const bun = { query: (sql) => { asked.push(sql); return { all: () => rows } } }
  expect(_internal.all(bun, "SELECT 1")).toBe(rows)
  expect(asked).toEqual(["SELECT 1"])
})

test("a node:sqlite store is read through prepare(), the way DatabaseSync answers", () => {
  const rows = [{ name: "token_v2", host: ".notion.so" }]
  const asked = []
  // node:sqlite's DatabaseSync has prepare() and no query() at all.
  const node = { prepare: (sql) => { asked.push(sql); return { all: () => rows } } }
  expect(_internal.all(node, "SELECT 2")).toBe(rows)
  expect(asked).toEqual(["SELECT 2"])
})

test("a user data directory named in the environment is read the way --user-data-dir is", () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-custom-"))
  try {
    const root = join(home, "custom-user-data")
    // Local State lives at the user data directory's root and names the
    // profiles below it, exactly as Chromium writes it under --user-data-dir.
    mkdirSync(join(root, "Profile 2", "Network"), { recursive: true })
    mkdirSync(join(root, "Default"), { recursive: true })
    writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {}, "Profile 2": {} }, last_used: "Profile 2" } }))
    writeFileSync(join(root, "Profile 2", "Network", "Cookies"), "not a database")
    writeFileSync(join(root, "Default", "Cookies"), "not a database")
    const stores = browserStores({ platform: "win32", home, env: { LOCALAPPDATA: join(home, "none"), NOTION_BROWSER_PROFILE: root } })
    expect(stores.length).toBe(2)
    // The profile named last used comes first, and both store layouts are found.
    expect(stores[0]).toMatchObject({ kind: "chromium", browser: "Chromium", root, profile: "Profile 2", db: join(root, "Profile 2", "Network", "Cookies") })
    expect(stores[1]).toMatchObject({ profile: "Default", db: join(root, "Default", "Cookies") })
  } finally {
    remove(home)
  }
})

test("findSession reads a user data directory that has only written DevToolsActivePort", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-devtools-only-"))
  const real = globalThis.WebSocket
  const endpoints = []
  const cookies = [
    { name: "token_v2", value: "live-session", domain: ".app.notion.com" },
    { name: "notion_user_id", value: USER, domain: ".app.notion.com" },
    { name: "tracking", value: "no", domain: ".notion.so" },
  ]
  class FakeWebSocket {
    constructor(endpoint) {
      this.listeners = {}
      endpoints.push(endpoint)
      Promise.resolve().then(() => {
        this.emit("open")
        this.emit("message", { data: JSON.stringify({ id: 1, result: { cookies } }) })
      })
    }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) }
    emit(type, event = {}) { for (const handler of this.listeners[type] ?? []) handler(event) }
    send() {}
    close() {}
  }
  globalThis.WebSocket = FakeWebSocket
  try {
    const root = join(home, "user-data")
    mkdirSync(root)
    // Only the port: there is no Cookies file anywhere in this directory.
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/devtools-path\n")
    const found = await findSession({ platform: "win32", home, env: { LOCALAPPDATA: join(home, "none"), NOTION_BROWSER_PROFILE: root } })
    expect(endpoints).toEqual(["ws://127.0.0.1:9222/devtools/browser/devtools-path"])
    expect(found).toEqual({ cookie: `token_v2=live-session; notion_user_id=${USER}`, browser: "Chromium", profile: "Default", via: "devtools", activeUserId: USER })
  } finally {
    globalThis.WebSocket = real
    remove(home)
  }
})

test.skipIf(!sqlite || !nodeRuntime)(`a real Node ${nodeRuntime ?? "runtime"} reads a synthetic store through node:sqlite's prepare()`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "magpie-node-sqlite-"))
  try {
    const key = randomBytes(32)
    const db = join(directory, "Cookies")
    // A real SQLite file, written by this runtime and read by the other one.
    writeFixture(db, [["token_v2", "node-session", ".notion.so"], ["notion_user_id", USER, "www.notion.so"]], key)
    try { Bun.gc(true) } catch { /* not bun */ }
    const localState = join(directory, "Local State")
    // The key is handed to the child through the same injectable `run` the
    // in-process fixtures use, so this test needs no DPAPI call of its own.
    writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const store = { kind: "chromium", browser: "Chrome", profile: "Default", root: directory, db, localState }
    const script = join(directory, "read.mjs")
    const sessionUrl = new URL("../session.mjs", import.meta.url).href
    writeFileSync(script, [
      `const { openDatabase, _internal } = await import(${JSON.stringify(sessionUrl)})`,
      `const store = ${JSON.stringify(store)}`,
      `const opened = await openDatabase(store.db)`,
      `const shape = { query: typeof opened.query, prepare: typeof opened.prepare }`,
      `opened.close()`,
      `const rows = await _internal.readStore(store, { platform: "win32", run: async () => ${JSON.stringify(key.toString("base64"))} })`,
      `process.stdout.write(JSON.stringify({ version: process.versions.node, shape, rows }))`,
    ].join("\n"))
    const output = await new Promise((resolve, reject) => {
      execFile("node", [script], { windowsHide: true, timeout: 15_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        // The experimental-feature notice is not a failure; anything else is,
        // and its text never holds a cookie value.
        const detail = String(stderr ?? "").split(/\r?\n/).filter((line) => line.trim() && !line.includes("ExperimentalWarning") && !line.includes("SQLite is an experimental feature")).join(" | ")
        reject(new Error(`the Node runtime could not read the synthetic store${detail ? `: ${detail}` : ""}`))
      })
    })
    const read = JSON.parse(output)
    // Under Node the Bun driver is absent, so the store must have been opened
    // by node:sqlite - prepare() and no query() - and read through it.
    expect(read.shape).toEqual({ query: "undefined", prepare: "function" })
    expect(read.rows).toEqual([
      { name: "token_v2", value: "node-session", host: ".notion.so" },
      { name: "notion_user_id", value: USER, host: "www.notion.so" },
    ])
  } finally {
    remove(directory)
  }
}, 20_000)

test("a user data directory named in the environment outranks a default browser's store", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-override-"))
  try {
    // The explicit override has only a debugging port: no store to open.
    const explicit = join(home, "explicit-user-data")
    mkdirSync(explicit)
    writeFileSync(join(explicit, "DevToolsActivePort"), "9222\n/devtools/browser/explicit-path\n")
    // The desktop's own Chrome has a readable store with a different session;
    // before the override was enforced, that store answered first.
    const local = join(home, "AppData", "Local")
    const defaultRoot = join(local, "Google", "Chrome", "User Data")
    mkdirSync(join(defaultRoot, "Default", "Network"), { recursive: true })
    writeFileSync(join(defaultRoot, "Default", "Network", "Cookies"), "not a database")
    const key = randomBytes(32)
    writeFileSync(join(defaultRoot, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const diskRows = [{ name: "token_v2", encrypted_value: gcmSeal("disk-session", key), host: ".notion.so" }]
    const copies = []
    const asked = []
    const found = await findSession({
      platform: "win32",
      home,
      env: { LOCALAPPDATA: local, NOTION_BROWSER_PROFILE: explicit },
      copyStore: (store) => { copies.push(store.root); return { path: store.db, remove: () => {} } },
      openDatabase: () => database(diskRows),
      run: async () => key.toString("base64"),
      connect: async (endpoint) => {
        asked.push(endpoint)
        return [
          { name: "token_v2", value: "live-session", domain: ".app.notion.com" },
          { name: "notion_user_id", value: USER, domain: ".app.notion.com" },
        ]
      },
    })
    // The default store is never opened, and the explicit root's port is
    // asked exactly once before any fallback.
    expect(copies).toEqual([])
    expect(asked).toEqual(["ws://127.0.0.1:9222/devtools/browser/explicit-path"])
    expect(found).toEqual({ cookie: `token_v2=live-session; notion_user_id=${USER}`, browser: "Chromium", profile: "Default", via: "devtools", activeUserId: USER })
  } finally {
    remove(home)
  }
})

test("the default browsers still read their store before their debugging port", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-default-order-"))
  try {
    const local = join(home, "AppData", "Local")
    const root = join(local, "Google", "Chrome", "User Data")
    mkdirSync(join(root, "Default", "Network"), { recursive: true })
    writeFileSync(join(root, "Default", "Network", "Cookies"), "not a database")
    writeFileSync(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/default-path\n")
    const key = randomBytes(32)
    writeFileSync(join(root, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const rows = [{ name: "token_v2", encrypted_value: gcmSeal("disk-session", key), host: ".notion.so" }]
    let asked = 0
    const found = await findSession({
      platform: "win32",
      home,
      env: { LOCALAPPDATA: local },
      copyStore: (store) => ({ path: store.db, remove: () => {} }),
      openDatabase: () => database(rows),
      run: async () => key.toString("base64"),
      connect: async () => { asked++; return [{ name: "token_v2", value: "live-session", domain: ".app.notion.com" }] },
    })
    // No override is named, so the disk store answers and the port is not
    // consulted at all.
    expect(asked).toBe(0)
    expect(found).toEqual({ cookie: "token_v2=disk-session", browser: "Chrome", profile: "Default" })
  } finally {
    remove(home)
  }
})

test("a named directory still outranks the default browser when it is written with a trailing separator or as a relative path", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-same-root-"))
  const previous = process.cwd()
  try {
    const explicit = join(home, "explicit-user-data")
    mkdirSync(explicit)
    writeFileSync(join(explicit, "DevToolsActivePort"), "9222\n/devtools/browser/explicit-path\n")
    const local = join(home, "AppData", "Local")
    const defaultRoot = join(local, "Google", "Chrome", "User Data")
    mkdirSync(join(defaultRoot, "Default", "Network"), { recursive: true })
    writeFileSync(join(defaultRoot, "Default", "Network", "Cookies"), "not a database")
    const key = randomBytes(32)
    writeFileSync(join(defaultRoot, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const diskRows = [{ name: "token_v2", encrypted_value: gcmSeal("disk-session", key), host: ".notion.so" }]
    // The same directory, written the two ways an operator actually writes it:
    // a trailing separator, and a path that is only absolute once resolved.
    process.chdir(home)
    for (const spelled of [`${explicit}${delimiter === ";" ? "\\" : "/"}`, "explicit-user-data"]) {
      const copies = []
      const asked = []
      const found = await findSession({
        platform: "win32",
        home,
        env: { LOCALAPPDATA: local, NOTION_BROWSER_PROFILE: spelled },
        copyStore: (store) => { copies.push(store.root); return { path: store.db, remove: () => {} } },
        openDatabase: () => database(diskRows),
        run: async () => key.toString("base64"),
        connect: async (endpoint) => {
          asked.push(endpoint)
          return [{ name: "token_v2", value: "live-session", domain: ".app.notion.com" }]
        },
      })
      // Spelling the directory differently must not drop it into the default
      // group: the default store stays closed and the named port is the one asked.
      expect(copies).toEqual([])
      expect(asked).toEqual(["ws://127.0.0.1:9222/devtools/browser/explicit-path"])
      expect(found.cookie).toBe("token_v2=live-session")
    }
  } finally {
    process.chdir(previous)
    remove(home)
  }
})

test("a named debugging port that cannot be read does not hide a session the default browser already has", async () => {
  const home = mkdtempSync(join(tmpdir(), "magpie-port-fallback-"))
  try {
    const explicit = join(home, "explicit-user-data")
    mkdirSync(explicit)
    writeFileSync(join(explicit, "DevToolsActivePort"), "9222\n/devtools/browser/explicit-path\n")
    const local = join(home, "AppData", "Local")
    const defaultRoot = join(local, "Google", "Chrome", "User Data")
    mkdirSync(join(defaultRoot, "Default", "Network"), { recursive: true })
    writeFileSync(join(defaultRoot, "Default", "Network", "Cookies"), "not a database")
    const key = randomBytes(32)
    writeFileSync(join(defaultRoot, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), randomBytes(32)]).toString("base64") } }))
    const diskRows = [{ name: "token_v2", encrypted_value: gcmSeal("disk-session", key), host: ".notion.so" }]
    const copies = []
    const found = await findSession({
      platform: "win32",
      home,
      env: { LOCALAPPDATA: local, NOTION_BROWSER_PROFILE: explicit },
      copyStore: (store) => { copies.push(store.root); return { path: store.db, remove: () => {} } },
      openDatabase: () => database(diskRows),
      run: async () => key.toString("base64"),
      connect: async () => { throw new Error("the debugging port refused") },
    })
    // The named port failed, so the default browser's own store is read next
    // instead of failing the whole sign-in.
    expect(copies).toEqual([defaultRoot])
    expect(found).toEqual({ cookie: "token_v2=disk-session", browser: "Chrome", profile: "Default" })
  } finally {
    remove(home)
  }
})
