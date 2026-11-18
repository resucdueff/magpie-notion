// Fails when a real Notion session token or another API secret looks committed.
// The check tests shapes, not values: fixtures and tests use short obvious
// placeholders, while a real token is long enough to be recognised here.
import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hasSecretShape } from "./secret-patterns.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const IGNORE = new Set([".git", "node_modules", "dist", "coverage"])
const MAX_BYTES = 2 * 1024 * 1024

export { hasSecretShape }

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}

export function findCommittedSecretHits(root = ROOT) {
  const hits = []
  for (const path of files(root)) {
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
      if (hasSecretShape(line)) hits.push(`${relative(root, path)}:${index + 1}`)
    })
  }
  return hits
}

export function isCliEntry(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false
  return metaUrl === pathToFileURL(resolve(argv1)).href
}

function main() {
  const hits = findCommittedSecretHits()
  if (hits.length) {
    console.error(`possible committed secrets:\n  ${hits.join("\n  ")}`)
    process.exit(1)
  }
  console.log("no committed Notion session or API token shapes found")
}

if (isCliEntry()) main()
