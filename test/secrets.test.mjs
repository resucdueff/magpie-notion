import { describe, expect, test } from "bun:test"
import { hasSecretShape } from "../scripts/check-secrets.mjs"

const fakeBody = ["fake", "Fixture", "Value"].join("")
const samples = [
  ["raw v02", ["v", "02", ":", fakeBody].join("")],
  ["raw v03", ["v", "03", ":", fakeBody].join("")],
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
