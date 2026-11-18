export const PATTERNS = [
  /token_v2=[A-Za-z0-9_%:.-]{20,}/,
  /\bv0\d(?::|%3A)[A-Za-z0-9_%.:-]{16,}/,
  /\bsecret_[A-Za-z0-9]{24,}/,
  /\bntn_[A-Za-z0-9]{24,}/,
  /\bsk-[A-Za-z0-9]{24,}/,
]

export function hasSecretShape(value) {
  return PATTERNS.some((pattern) => pattern.test(value))
}
