// Shared redaction for local shadow evidence, summaries, and diagnostics.

export const MAX_REDACTED_TEXT = 8_000;

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:gh[psoru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
  /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b/gi,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi,
  /\bAuthorization\s*:\s*[^\r\n]+/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?/gi,
];

export function redactSecret(input: unknown, sensitivePaths: readonly string[] = []): string {
  let value = String(input ?? "").replace(/\[[0-?]*[ -/]*[@-~]/g, "");
  for (const secret of SECRET_PATTERNS) value = value.replace(secret, "[REDACTED]");
  const home = process.env.HOME;
  const paths = [...sensitivePaths, ...(home ? [home] : [])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const candidate of paths) value = value.split(candidate).join("<redacted-path>");
  return value.slice(0, MAX_REDACTED_TEXT);
}
