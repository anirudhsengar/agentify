#!/usr/bin/env node
// inspect-log.mjs
//
// Inspect an agentify run log (JSONL) and surface:
//   - run start/end summary (model, duration, cost, status)
//   - tool call distribution (which tools the main agent used)
//   - spawn_explorer invocations: target_path, focus, args
//   - subagent_spawned events: target_path, focus, duration_ms, is_error
//   - tool errors and their reasons
//   - turn count and mean turn latency
//
// Usage:
//   node inspect-log.mjs <path-to-log.jsonl>
//   node inspect-log.mjs --list                    # list all logs in ~/.agentify/logs/agentify/
//   node inspect-log.mjs --latest                  # inspect the most recent log
//   node inspect-log.mjs --latest --verbose        # include per-spawn report excerpts
//
// Designed to be a fast, dependency-free diagnostic tool. Run after every
// `agentify` run to audit what the main agent did and which directories
// it delegated to sub-agents (if any).

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Parse args (Phase 4.4 hardening).
const argv = process.argv.slice(2);
let logDirOverride = null;
let maxErrorLength = 200;
let filterEvent = null;
let fromTs = null;
let toTs = null;
let useLatest = false;
let useList = false;
let verbose = false;
let pathArg = null;
let stableLatest = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--verbose") verbose = true;
  else if (a === "--list") useList = true;
  else if (a === "--latest") useLatest = true;
  else if (a === "--stable-latest") stableLatest = true;
  else if (a === "--log-dir" && i + 1 < argv.length) logDirOverride = argv[++i];
  else if (a === "--max-error-length" && i + 1 < argv.length) maxErrorLength = parseInt(argv[++i], 10);
  else if (a === "--filter" && i + 1 < argv.length) filterEvent = argv[++i];
  else if (a === "--from" && i + 1 < argv.length) fromTs = argv[++i];
  else if (a === "--to" && i + 1 < argv.length) toTs = argv[++i];
  else if (!a.startsWith("--")) pathArg = a;
}

const LOG_DIR = logDirOverride ?? join(homedir(), ".agentify", "logs", "agentify");
const VERBOSE = verbose;

function fmt(n) {
  return n.toString().padStart(4);
}

function pct(part, total) {
  if (total === 0) return "  0%";
  return `${Math.round((part / total) * 100).toString().padStart(3)}%`;
}

function parseLog(text) {
  // The log has lines like:
  //   {"ts":...,"event":"agentify.session_event","payload":"{\"pi_event_type\":\"...\",\"event\":{...}}"}
  // where `payload` is a JSON string containing the inner event. We unwrap
  // both layers and produce a flat event list.
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.event === "agentify.session_event" && typeof entry.payload === "string") {
      let inner;
      try { inner = JSON.parse(entry.payload); } catch { continue; }
      const ev = inner.event;
      if (!ev) continue;
      events.push({
        ts: entry.ts,
        kind: "session",
        type: ev.type,
        toolName: ev.toolName,
        args: ev.args,
        isError: ev.isError,
        result: ev.result,
      });
    } else {
      events.push({
        ts: entry.ts,
        kind: "log",
        type: entry.event,
        payload: entry.payload,
      });
    }
  }
  return events;
}

function summarize(events) {
  const logEvents = events.filter((e) => e.kind === "log");
  const sessionEvents = events.filter((e) => e.kind === "session");

  // Event-type distribution (top-level log events)
  const byType = new Map();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

  // Tool call distribution (from tool_execution_start)
  const toolStarts = sessionEvents.filter((e) => e.type === "tool_execution_start");
  const byTool = new Map();
  for (const t of toolStarts) byTool.set(t.toolName ?? "?", (byTool.get(t.toolName ?? "?") ?? 0) + 1);

  // Errors
  const toolEnds = sessionEvents.filter((e) => e.type === "tool_execution_end");
  const errors = toolEnds.filter((e) => e.isError).map((e) => ({
    ts: e.ts,
    tool: e.toolName,
    reason: extractErrorReason(e.result),
  }));

  // spawn_explorer invocations
  const spawnCalls = toolStarts.filter((e) => e.toolName === "spawn_explorer");
  const spawnEvents = logEvents.filter((e) => e.type === "agentify.subagent_spawned");

  // Turn count from message_end
  const turnEnds = sessionEvents.filter((e) => e.type === "turn_end").length;

  // Run start / end
  const runStart = logEvents.find((e) => e.type === "agentify.run_start")?.payload;
  const runEnd = logEvents.find((e) => e.type === "agentify.run_end")?.payload;
  const sessionEnd = logEvents.find((e) => e.type === "agentify.session_end")?.payload;

  return {
    byType,
    byTool,
    errors,
    spawnCalls,
    spawnEvents,
    turnEnds,
    runStart,
    runEnd,
    sessionEnd,
    totalEvents: events.length,
  };
}

function extractErrorReason(result, maxLen = maxErrorLength) {
  if (!result || typeof result !== "object") return "(unknown)";
  if (Array.isArray(result.content) && result.content[0]?.text) {
    return String(result.content[0].text).slice(0, maxLen);
  }
  return JSON.stringify(result).slice(0, maxLen);
}

function printSummary(s) {
  console.log("=".repeat(70));
  console.log("AGENTIFY LOG INSPECTION");
  console.log("=".repeat(70));

  if (s.runStart) {
    const rs = typeof s.runStart === "string" ? safeJson(s.runStart) : s.runStart;
    console.log("");
    console.log("Run start:");
    console.log(`  cwd:              ${rs.cwd ?? "?"}`);
    console.log(`  model:            ${rs.model ?? "?"}`);
    console.log(`  thinking_level:   ${rs.thinking_level ?? "?"}`);
    console.log(`  agentify_version: ${rs.agentify_version ?? "?"}`);
    console.log(`  sdk_version:      ${rs.sdk_version ?? rs.pi_version ?? "?"}`);
    console.log(`  tool_allowlist:   ${(rs.tool_allowlist ?? []).join(", ")}`);
    console.log(`  prompt_sha256:    ${(rs.system_prompt_sha256 ?? "").slice(0, 16)}…`);
  }

  if (s.runEnd) {
    const re = typeof s.runEnd === "string" ? safeJson(s.runEnd) : s.runEnd;
    console.log("");
    console.log("Run end:");
    console.log(`  status:           ${re.status ?? "?"}`);
    console.log(`  duration_ms:      ${re.duration_ms ?? "?"}  (${((re.duration_ms ?? 0) / 1000).toFixed(1)}s)`);
    console.log(`  files_written:    ${re.files_written ?? "?"}`);
    console.log(`  total_turns:      ${re.total_turns ?? "?"}`);
    console.log(`  mean_turn_ms:     ${re.mean_turn_latency_ms ?? "?"}`);
    console.log(`  input_tokens:     ${re.total_input_tokens ?? "?"}`);
    console.log(`  output_tokens:    ${re.total_output_tokens ?? "?"}`);
    console.log(`  cache_read:       ${re.total_cache_read_tokens ?? "?"}`);
    console.log(`  cost_usd:         $${re.total_cost_usd?.toFixed(6) ?? "?"}`);
  }

  console.log("");
  console.log(`Total events: ${s.totalEvents}, turn_end count: ${s.turnEnds}`);
  console.log("");
  console.log("Event-type distribution:");
  const sorted = [...s.byType.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sorted) {
    console.log(`  ${fmt(n)} × ${t}`);
  }

  console.log("");
  const totalToolCalls = [...s.byTool.values()].reduce((a, b) => a + b, 0);
  console.log(`Tool call distribution (${totalToolCalls} total):`);
  const sortedTools = [...s.byTool.entries()].sort((a, b) => b[1] - a[1]);
  for (const [t, n] of sortedTools) {
    console.log(`  ${fmt(n)} × ${t}  ${pct(n, totalToolCalls)}`);
  }

  console.log("");
  console.log(`Sub-agent spawns: ${s.spawnCalls.length} spawn_explorer calls, ${s.spawnEvents.length} agentify.subagent_spawned log events`);
  if (s.spawnCalls.length > 0) {
    console.log("");
    console.log("spawn_explorer invocations:");
    let i = 1;
    for (const sc of s.spawnCalls) {
      const ev = s.spawnEvents.find((e) => Math.abs(new Date(e.ts).getTime() - new Date(sc.ts).getTime()) < 60_000);
      const dur = ev?.payload?.details?.duration_ms;
      const err = ev?.payload?.is_error;
      const target = sc.args?.target_path ?? "?";
      const focus = sc.args?.focus ?? "(none)";
      const durStr = dur !== undefined ? `${dur}ms` : "—";
      const errStr = err ? "  ERROR" : "";
      console.log(`  ${i.toString().padStart(2)}. ${sc.ts}  target=${target}${focus ? "  focus=" + focus : ""}  duration=${durStr}${errStr}`);
      if (VERBOSE && ev) {
        const d = ev.payload.details ?? {};
        console.log(`      report_length: ${d.report_length ?? "?"}`);
        if (d.target_path) console.log(`      target_path:   ${d.target_path}`);
        if (d.focus) console.log(`      focus:         ${d.focus}`);
      }
      i++;
    }
  } else {
    console.log("  (none — the main agent self-explored every directory)");
  }

  if (s.errors.length > 0) {
    console.log("");
    console.log(`Tool errors (${s.errors.length}):`);
    for (const e of s.errors) {
      console.log(`  ${e.ts}  ${e.tool}: ${e.reason}`);
    }
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function listLogs() {
  let files;
  try { files = await readdir(LOG_DIR); } catch { return []; }
  const rows = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(LOG_DIR, f);
    const st = await stat(full);
    rows.push({ name: f, path: full, mtime: st.mtime, size: st.size });
  }
  if (stableLatest) {
    // Sort by filename descending (lexicographic) — the filename includes
    // the ISO timestamp, so this is stable across same-second runs.
    rows.sort((a, b) => b.name.localeCompare(a.name));
  } else {
    // Default: sort by mtime descending.
    rows.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
  return rows;
}

async function main() {
  if (useList) {
    const logs = await listLogs();
    console.log("Available logs in", LOG_DIR);
    for (const l of logs) {
      console.log(`  ${l.mtime.toISOString()}  ${(l.size / 1024).toFixed(1).padStart(8)} KB  ${l.name}`);
    }
    return;
  }

  let path = pathArg;
  if (useLatest || (!path && !useList)) {
    const logs = await listLogs();
    if (logs.length === 0) {
      console.error("No logs found in", LOG_DIR);
      process.exit(1);
    }
    path = logs[0].path;
    console.error(`Using latest: ${path}\n`);
  }

  const text = await readFile(path, "utf-8");
  const events = parseLog(text);
  const summary = summarize(events);
  printSummary(summary);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
