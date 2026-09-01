import * as path from "node:path";
import { readBoundedRegularFile } from "./bounded-regular-file.ts";

const MAX_POLICY_FILE_BYTES = 256 * 1024;
const MAX_POLICY_TOTAL_BYTES = 1024 * 1024;

const POLICY_BASENAMES = new Set([
  "agents.md",
  "claude.md",
  "contributing.md",
  "contribution.md",
  "code_of_conduct.md",
  "copilot-instructions.md",
  "pull_request_template.md",
]);

const AI_SUBJECT = String.raw`(?:\bai\b|a\.i\.|\bllms?\b|\blarge language models?\b|\blanguage models?\b|\bgenerative (?:ai|artificial intelligence)\b|\bcoding agents?\b|\bagentic tools?\b)`;
const PERSISTENT_WORK = String.raw`(?:contribut(?:e|ing|ion)|code|documentation|test(?: data)?|patch|pull request|repository (?:change|write)|generated (?:content|output)|authored (?:content|work))`;
const PROHIBITION = String.raw`\b(?:do not|don't|must not|never|forbid(?:s|den)?|prohibit(?:s|ed)?|not (?:allow|accept)(?:ed)?|refuse(?:s|d)?|no)\b`;
const PROHIBITED_STATE = String.raw`\b(?:forbidden|prohibited|not allowed|not accepted|must be refused|strictly forbidden)\b`;
const AUTONOMOUS_AGENT = String.raw`(?:unsupervised|autonomous)\s+(?:coding agents?|agentic tools?)\b`;

const RESTRICTIVE_PATTERNS = [
  new RegExp(`${PROHIBITION}[\\s*_]{1,12}(?:use(?: of)?\\s+)?${AUTONOMOUS_AGENT}`, "iu"),
  new RegExp(`${AUTONOMOUS_AGENT}[\\s*_]{1,12}(?:are\\s+)?${PROHIBITED_STATE}`, "iu"),
  new RegExp(`${PROHIBITION}[^.\\n]{0,160}${AI_SUBJECT}[^.\\n]{0,160}${PERSISTENT_WORK}`, "iu"),
  new RegExp(`${PROHIBITION}[^.\\n]{0,160}${PERSISTENT_WORK}[^.\\n]{0,160}${AI_SUBJECT}`, "iu"),
  new RegExp(`${AI_SUBJECT}[^.\\n]{0,160}${PERSISTENT_WORK}[^.\\n]{0,100}${PROHIBITED_STATE}`, "iu"),
  new RegExp(`${PERSISTENT_WORK}[^.\\n]{0,160}${AI_SUBJECT}[^.\\n]{0,100}${PROHIBITED_STATE}`, "iu"),
] as const;

export interface RestrictiveRepositoryPolicy {
  path: string;
  summary: string;
}

function isPolicyPath(repositoryPath: string): boolean {
  const normalized = repositoryPath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized).toLowerCase();
  if (POLICY_BASENAMES.has(basename)) return true;
  if (/\.(?:md|rst|txt)$/u.test(basename)
    && /(?:^|[-_.])(?:policy|policies|instructions|rules)(?:[-_.]|$)/u.test(basename)) return true;
  return normalized.toLowerCase().startsWith(".github/instructions/")
    && basename.endsWith(".instructions.md");
}

function restrictiveSummary(content: string): string | null {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (const pattern of RESTRICTIVE_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    return match[0].replace(/\s+/gu, " ").trim().slice(0, 240);
  }
  return null;
}

/**
 * Inspect only bounded, tracked, regular policy files for an explicit ban on
 * AI/LLM-authored persistent repository work or autonomous agent use. Repository prose is untrusted:
 * it can reduce Agentify's authority, never expand it.
 */
export function detectRestrictiveRepositoryPolicy(
  cwd: string,
  trackedPaths: ReadonlyArray<string>,
): RestrictiveRepositoryPolicy | null {
  let totalBytes = 0;
  for (const repositoryPath of [...trackedPaths].sort((left, right) => left.localeCompare(right))) {
    if (!isPolicyPath(repositoryPath)) continue;
    const absolute = path.join(cwd, ...repositoryPath.split("/"));
    const bytes = readBoundedRegularFile(absolute, MAX_POLICY_FILE_BYTES);
    if (bytes === null) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_POLICY_TOTAL_BYTES) break;
    const summary = restrictiveSummary(bytes.toString("utf8"));
    if (summary !== null) return { path: repositoryPath, summary };
  }
  return null;
}
