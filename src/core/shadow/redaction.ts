// Redaction helpers shared between the GitHub Actions runner and the local
// operator runner. Keeping the rules in one place ensures that local evidence
// packets carry the same protections as GitHub-hosted ones.
export const MAX_REDACTED_TEXT = 8_000;

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // GitHub PATs and OAuth tokens.
  { re: /(gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, replacement: "[REDACTED]" },
  // Generic high-entropy API keys / secrets.
  { re: /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi, replacement: "[REDACTED]" },
  // PEM-encoded private keys (with or without surrounding content).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED]" },
];

/**
 * Redact secrets from a string while capping the length so that an oversized
 * issue body cannot bloat the evidence packet or leak auxiliary secrets
 * hidden in the overflow.
 */
export function redactSecret(value: unknown): string {
  const raw = String(value ?? "");
  const trimmed = raw.length > MAX_REDACTED_TEXT ? raw.slice(0, MAX_REDACTED_TEXT) : raw;
  let next = trimmed;
  for (const { re, replacement } of PATTERNS) next = next.replace(re, replacement);
  return next;
}