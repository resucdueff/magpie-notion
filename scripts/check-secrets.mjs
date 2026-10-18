// Fails when a real Notion session token or another API secret looks committed.
// The check tests shapes, not values: fixtures and tests use short obvious
// placeholders, while a real token is long enough to be recognised here.
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const PATTERNS = [
  /token_v2=[A-Za-z0-9_%:.-]{20,}/,
  /\bv0\d(?::|%3A)[A-Za-z0-9_%.:-]{16,}/,
  /\bsecret_[A-Za-z0-9]{24,}/,
  /\bntn_[A-Za-z0-9]{24,}/,
  /\bsk-[A-Za-z0-9]{24,}/,
]
const IGNORE = new Set([".git", "node_modules", "dist", "coverage"])
const MAX_BYTES = 2 * 1024 * 1024

export function hasSecretShape(value) {
  return PATTERNS.some((pattern) => pattern.test(value))
}

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

const hits = []
for (const path of files(ROOT)) {
  let content
  try {
    if (readFileSync(path).length > MAX_BYTES) continue
    content = readFileSync(path, "utf8")
  } catch {
    continue
  }
  if (content.includes("\u0000")) continue
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (hasSecretShape(line)) hits.push(`${relative(ROOT, path)}:${index + 1}`)
  })
}

if (hits.length) {
  console.error(`possible committed secrets:\n  ${hits.join("\n  ")}`)
  process.exit(1)
}
console.log("no committed Notion session or API token shapes found")
