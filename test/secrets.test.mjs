import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hasSecretShape } from "../scripts/secret-patterns.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const scanner = join(root, "scripts", "check-secrets.mjs")
const fakeBody = ["fake", "Fixture", "Value"].join("")
const v03 = ["v", "03", ":", fakeBody].join("")
const samples = [
  ["raw v02", ["v", "02", ":", fakeBody].join("")],
  ["raw v03", v03],
  ["encoded v02", ["v", "02", "%3A", fakeBody].join("")],
  ["encoded v03", ["v", "03", "%3A", fakeBody].join("")],
]

describe("secret shape detection", () => {
  for (const [name, sample] of samples) {
    test(`detects ${name} tokens`, () => {
      expect(hasSecretShape(sample)).toBe(true)
    })
  }

  test("ignores short placeholders", () => {
    expect(hasSecretShape("fake-token-v2")).toBe(false)
  })
})

test("importing the secrets scanner does not scan the tree or exit", () => {
  const probe = join(root, "leak-import-probe.mjs")
  writeFileSync(probe, `const t = ${JSON.stringify(v03)}\n`)
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const scanner = ${JSON.stringify(pathToFileURL(scanner).href)};
      const { hasSecretShape } = await import(scanner);
      if (typeof hasSecretShape !== "function") process.exit(2);
      if (!hasSecretShape(${JSON.stringify(v03)})) process.exit(3);
      console.log("imported");
    `], { cwd: root, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("imported")
    expect(result.stderr).not.toContain("possible committed secrets")
  } finally {
    rmSync(probe, { force: true })
  }
})

test("CLI reports a matching file and exits 1", () => {
  const probe = join(root, "leak-cli-probe.mjs")
  writeFileSync(probe, `const t = ${JSON.stringify(v03)}\n`)
  try {
    const result = spawnSync(process.execPath, [scanner], { cwd: root, encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("leak-cli-probe.mjs:1")
    expect(result.stdout).not.toContain("no committed Notion session or API token shapes found")
  } finally {
    rmSync(probe, { force: true })
  }
})

test("CLI prints the clean message and exits 0", () => {
  const result = spawnSync(process.execPath, [scanner], { cwd: root, encoding: "utf8" })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain("no committed Notion session or API token shapes found")
  expect(result.stderr).toBe("")
})

test("findCommittedSecretHits scans a given root without exiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-secrets-"))
  try {
    writeFileSync(join(dir, "clean.js"), "const token = 'fake-token-v2'\n")
    writeFileSync(join(dir, "hit.js"), `const t = ${JSON.stringify(v03)}\n`)
    const { findCommittedSecretHits } = await import("../scripts/check-secrets.mjs")
    expect(findCommittedSecretHits(dir).some((hit) => hit.endsWith("hit.js:1"))).toBe(true)
    expect(findCommittedSecretHits(dir).some((hit) => hit.includes("clean.js"))).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
