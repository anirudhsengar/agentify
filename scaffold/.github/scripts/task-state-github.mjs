#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const STATE_MARKER = "agentify-task-state:v1";
const RECORD_MARKER = "agentify-task-record:v1";
const MAX_COMMENT_BYTES = 60 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const STATE_LABELS = new Set([
  "agentify:queue",
  "agentify:new", "agentify:needs-information", "agentify:ready", "agentify:planned",
  "agentify:awaiting-approval", "agentify:approved", "agentify:implementing",
  "agentify:validating", "agentify:reviewing", "agentify:fixing", "agentify:draft-pr-open",
  "agentify:completed", "agentify:stopped", "agentify:refused", "agentify:blocked",
  "agentify:stale-base", "agentify:budget-exhausted", "agentify:failed", "agentify:recovering",
]);
const RECORD_VALIDATORS = new Map([
  ["plan", "validate-plan"],
  ["planner", "validate-planner"],
  ["specialist", "validate-specialist"],
  ["builder-call", "validate-builder-call"],
  ["builder", "validate-builder-result"],
  ["validation", "validate-validation-result"],
  ["review", "validate-review"],
  ["state-event", "validate-state"],
  ["accepted-evidence", "validate-accepted-evidence"],
]);

function fail(message) {
  throw new Error(message);
}

function repository() {
  const value = process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO;
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) fail("trusted repository identity is missing");
  return value;
}

function runtimePath() {
  return path.resolve(process.env.AGENTIFY_TASK_RUNTIME ?? ".github/agentify/task-runtime.mjs");
}

function boundedFile(filePath, maximum = MAX_RECORD_BYTES) {
  const absolute = path.resolve(filePath);
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > maximum) fail(`bounded regular file required: ${filePath}`);
  return absolute;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(boundedFile(filePath), "utf8"));
  } catch (error) {
    fail(`${label} is not valid bounded JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function gh(args, input) {
  const testDriver = process.env.NODE_ENV === "test"
    ? process.env.AGENTIFY_GH_TEST_DRIVER
    : undefined;
  const executable = testDriver ? process.execPath : "gh";
  const executableArgs = testDriver
    ? [boundedFile(testDriver), ...args]
    : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    input,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`trusted GitHub mutation failed: ${(result.stderr || result.stdout || "unknown failure").slice(0, 1_000)}`);
  }
  return result.stdout;
}

function api(method, endpoint, body) {
  const args = ["api", "--method", method, endpoint];
  const input = body === undefined ? undefined : JSON.stringify(body);
  if (body !== undefined) args.push("--input", "-");
  const output = gh(args, input);
  return output.trim() ? JSON.parse(output) : null;
}

function comments(issue) {
  const output = gh([
    "api",
    `repos/${repository()}/issues/${issue}/comments?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  const pages = JSON.parse(output);
  if (!Array.isArray(pages)) fail("GitHub comments response is invalid");
  const flattened = pages.flat();
  if (flattened.length > 1_000) {
    fail("issue contains more comments than the bounded state scan can safely inspect");
  }
  return flattened;
}

function trustedBotLogins() {
  return new Set([
    "github-actions[bot]",
    ...(process.env.AGENTIFY_TRUSTED_BOT_LOGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
}

function assertTrustedComment(comment, label) {
  if (!comment?.user || comment.user.type !== "Bot" || !trustedBotLogins().has(comment.user.login)) {
    fail(`${label} is not owned by a trusted Agentify bot identity`);
  }
  if (Buffer.byteLength(comment.body ?? "", "utf8") > MAX_COMMENT_BYTES) fail(`${label} exceeds the bounded comment size`);
}

function stateComments(issue) {
  return comments(issue).filter((comment) => (comment.body ?? "").includes(`<!-- ${STATE_MARKER} `));
}

function machineRecordComments(issue, type, key) {
  const prefix = `<!-- ${RECORD_MARKER} type=${type} key=${key} `;
  return comments(issue).filter((comment) => (comment.body ?? "").includes(prefix));
}

function parseStateBody(body) {
  const match = /```agentify-task-state\n([A-Za-z0-9_-]+)\n```/.exec(body);
  if (!match) fail("machine-owned task state payload is missing");
  try {
    return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    fail("machine-owned task state payload is invalid");
  }
}

function stable(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, stable(value[key])]));
  }
  fail("machine record contains an unsupported value");
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function runRuntime(command, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-task-runtime-"));
  const input = path.join(directory, "input.json");
  const output = path.join(directory, "output.json");
  try {
    writeJson(input, value);
    const result = spawnSync(process.execPath, [runtimePath(), command, input, output], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, AGENT_PAT: undefined },
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) fail((result.stderr || result.stdout || `${command} failed`).slice(0, 2_000));
    return readJson(output, `${command} output`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function readState(issue) {
  const matches = stateComments(issue);
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail("multiple machine-owned task state comments claim this issue");
  const comment = matches[0];
  assertTrustedComment(comment, "task state comment");
  const state = parseStateBody(comment.body);
  runRuntime("validate-state", state);
  return { comment, state };
}

function renderState(state) {
  return runRuntime("render-state", state);
}

function ensureStateLabel(label) {
  if (!STATE_LABELS.has(label)) return;
  try {
    api("GET", `repos/${repository()}/labels/${encodeURIComponent(label)}`);
  } catch {
    api("POST", `repos/${repository()}/labels`, {
      name: label,
      color: "6f42c1",
      description: "Agentify lifecycle projection; machine-owned state remains authoritative.",
    });
  }
}

function updateProjection(issue, labels) {
  for (const label of labels) ensureStateLabel(label);
  const issueValue = api("GET", `repos/${repository()}/issues/${issue}`);
  const existing = new Set((issueValue.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
  for (const label of existing) {
    if (!STATE_LABELS.has(label)) continue;
    if (labels.includes(label)) continue;
    try {
      api("DELETE", `repos/${repository()}/issues/${issue}/labels/${encodeURIComponent(label)}`);
    } catch {
      // Labels are projections. A concurrent projection update may already have removed it.
    }
  }
  const additions = labels.filter((label) => STATE_LABELS.has(label) && !existing.has(label));
  if (additions.length > 0) api("POST", `repos/${repository()}/issues/${issue}/labels`, { labels: additions });
}

function writeState(issue, stateFile) {
  const next = readJson(stateFile, "task state");
  runRuntime("validate-state", next);
  const rendered = renderState(next);
  if (typeof rendered.body !== "string" || Buffer.byteLength(rendered.body, "utf8") > MAX_COMMENT_BYTES) {
    fail("rendered task state comment is invalid or oversized");
  }
  const current = readState(issue);
  let mode;
  if (current === null) {
    if (next.revision !== 1 || next.prior_state_digest !== null) fail("initial task state must start at revision 1");
    mode = "create";
  } else if (next.current_digest === current.state.current_digest && next.revision === current.state.revision) {
    mode = "recover";
  } else {
    if (next.task_id !== current.state.task_id) fail("task state update changes the stable task identity");
    if (next.revision !== current.state.revision + 1 || next.prior_state_digest !== current.state.current_digest) {
      fail(`stale task state mutation: current revision is ${current.state.revision}`);
    }
    mode = "update";
  }

  // The optimistic comparison above is read-only. Once it succeeds, write the
  // immutable event first and the mutable current snapshot second. A crash
  // between those operations is recovered by replaying this exact state.
  const eventKey = `${next.task_id}:r${next.revision}`;
  const eventRecord = writeRecord(issue, "state-event", eventKey, stateFile);
  let comment;
  let status;
  if (mode === "create") {
    comment = api("POST", `repos/${repository()}/issues/${issue}/comments`, { body: rendered.body });
    status = "created";
  } else if (mode === "recover") {
    comment = current.comment;
    status = "recovered";
  } else {
    comment = api("PATCH", `repos/${repository()}/issues/comments/${current.comment.id}`, { body: rendered.body });
    status = "updated";
  }
  updateProjection(issue, rendered.labels ?? []);
  return {
    status,
    comment_id: comment.id,
    state_event_comment_id: eventRecord.comment_id,
    state: next,
    labels: rendered.labels ?? [],
  };
}

function validateRecord(type, value) {
  const validator = RECORD_VALIDATORS.get(type);
  if (validator) runRuntime(validator, value);
  else fail(`unsupported machine record type '${type}'`);
}

function encodeRecord(type, key, value) {
  validateRecord(type, value);
  const raw = Buffer.from(JSON.stringify(stable(value)), "utf8");
  if (raw.length > MAX_RECORD_BYTES) fail("machine record exceeds 512 KiB before compression");
  const recordDigest = digest(value);
  const payload = zlib.gzipSync(raw, { level: 9 }).toString("base64url");
  const body = [
    `<!-- ${RECORD_MARKER} type=${type} key=${key} digest=${recordDigest} -->`,
    `**Agentify ${type} record:** \`${key}\``,
    `**Digest:** \`${recordDigest}\``,
    "",
    "This bounded typed record is machine-owned evidence. Free-form model transcripts and raw validation logs are not stored here.",
    "",
    "<details><summary>Compressed typed payload</summary>",
    "",
    `\`\`\`agentify-task-record\n${payload}\n\`\`\``,
    "",
    "</details>",
  ].join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) fail("compressed machine record exceeds the bounded comment size");
  return { body, digest: recordDigest };
}

function parseRecord(comment, expectedType, expectedKey) {
  assertTrustedComment(comment, `${expectedType} record`);
  const marker = new RegExp(`<!-- ${RECORD_MARKER} type=([a-z-]+) key=([A-Za-z0-9._:-]+) digest=([0-9a-f]{64}) -->`).exec(comment.body ?? "");
  if (!marker || marker[1] !== expectedType || marker[2] !== expectedKey) fail("machine record marker does not match its lookup identity");
  const payload = /```agentify-task-record\n([A-Za-z0-9_-]+)\n```/.exec(comment.body ?? "")?.[1];
  if (!payload) fail("machine record payload is missing");
  let value;
  try {
    const raw = zlib.gunzipSync(Buffer.from(payload, "base64url"));
    if (raw.length > MAX_RECORD_BYTES) fail("machine record expands beyond 512 KiB");
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`machine record payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (digest(value) !== marker[3]) fail("machine record digest does not match its payload");
  validateRecord(expectedType, value);
  return { comment_id: comment.id, digest: marker[3], value };
}

function readRecord(issue, type, key) {
  const matches = machineRecordComments(issue, type, key);
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail(`multiple ${type} records claim key ${key}`);
  return parseRecord(matches[0], type, key);
}

function writeRecord(issue, type, key, filePath) {
  if (!/^[a-z-]{1,40}$/.test(type) || !/^[A-Za-z0-9._:-]{1,256}$/.test(key)) fail("machine record type or key is unsafe");
  const value = readJson(filePath, `${type} record`);
  const encoded = encodeRecord(type, key, value);
  const current = readRecord(issue, type, key);
  if (current) {
    if (current.digest !== encoded.digest) fail(`immutable ${type} record ${key} already exists with different content`);
    return { status: "recovered", ...current };
  }
  const comment = api("POST", `repos/${repository()}/issues/${issue}/comments`, { body: encoded.body });
  return { status: "created", comment_id: comment.id, digest: encoded.digest, value };
}

function boundedPublicComment(issue, filePath) {
  const absolute = boundedFile(filePath, 16_000);
  let body = fs.readFileSync(absolute, "utf8").replaceAll("\0", "").replace(/\r\n?/g, "\n").trim();
  body = body.replace(/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*(?:Bearer\s+)?[^\s]+/gi, "[REDACTED CREDENTIAL]")
    .split("\n")
    .filter((line) => !/^\s*at\s+.+\(.+?:\d+:\d+\)\s*$/.test(line))
    .join("\n")
    .slice(0, 12_000);
  if (!body) fail("public task comment is empty");
  const comment = api("POST", `repos/${repository()}/issues/${issue}/comments`, { body });
  return { comment_id: comment.id };
}

function main() {
  const [command, issueText, ...args] = process.argv.slice(2);
  const issue = Number(issueText);
  if (!command || !Number.isSafeInteger(issue) || issue < 1) {
    fail("usage: task-state-github.mjs COMMAND ISSUE ...");
  }
  let result;
  switch (command) {
    case "state-read": {
      const [output] = args;
      if (!output) fail("state-read requires OUTPUT.json");
      result = readState(issue);
      writeJson(output, result);
      return;
    }
    case "state-write": {
      const [stateFile, output] = args;
      if (!stateFile || !output) fail("state-write requires STATE.json OUTPUT.json");
      result = writeState(issue, stateFile);
      writeJson(output, result);
      return;
    }
    case "record-read": {
      const [type, key, output] = args;
      if (!type || !key || !output) fail("record-read requires TYPE KEY OUTPUT.json");
      result = readRecord(issue, type, key);
      writeJson(output, result);
      return;
    }
    case "record-write": {
      const [type, key, filePath, output] = args;
      if (!type || !key || !filePath || !output) fail("record-write requires TYPE KEY RECORD.json OUTPUT.json");
      result = writeRecord(issue, type, key, filePath);
      writeJson(output, result);
      return;
    }
    case "comment": {
      const [filePath, output] = args;
      if (!filePath || !output) fail("comment requires BODY.txt OUTPUT.json");
      result = boundedPublicComment(issue, filePath);
      writeJson(output, result);
      return;
    }
    default:
      fail(`unknown task GitHub state command '${command}'`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentify task GitHub state failed: ${message.slice(0, 2_000)}`);
  process.exit(1);
}
