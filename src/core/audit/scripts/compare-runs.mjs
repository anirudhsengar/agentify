#!/usr/bin/env node
// compare-runs.mjs
//
// Diff two agentify run logs side by side. Shows: model, duration,
// cost, per-dimension coverage, tool call distribution, error count,
// and the gap_detected/gap_closed transition counts.
//
// Usage:
//   node compare-runs.mjs <log1> <log2>
//
// Output: a Markdown table (single page) suitable for embedding in
// a Notion page or a CI summary.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".agentify", "logs", "agentify");

function parseLog(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    events.push(entry);
  }
  return events;
}

function summarize(events) {
  const summary = {
    runStart: null,
    runEnd: null,
    sessionEnd: null,
    mapWrites: [],
    gapTransitions: { detected: 0, closed: 0 },
    subagentSpawns: 0,
    errors: 0,
    toolStarts: new Map(),
  };
  for (const e of events) {
    if (e.event === "agentify.run_start") {
      summary.runStart = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    } else if (e.event === "agentify.run_end") {
      summary.runEnd = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    } else if (e.event === "agentify.session_end") {
      summary.sessionEnd = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
    } else if (e.event === "agentify.map_written") {
      const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      summary.mapWrites.push(payload);
    } else if (e.event === "agentify.gap_detected") {
      summary.gapTransitions.detected += 1;
    } else if (e.event === "agentify.gap_closed") {
      summary.gapTransitions.closed += 1;
    } else if (e.event === "agentify.subagent_spawned") {
      summary.subagentSpawns += 1;
    } else if (e.event === "agentify.session_event") {
      const inner = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      const ev = inner?.event;
      if (ev?.type === "tool_execution_start") {
        const t = ev.toolName ?? "?";
        summary.toolStarts.set(t, (summary.toolStarts.get(t) ?? 0) + 1);
      } else if (ev?.type === "tool_execution_end" && ev?.isError) {
        summary.errors += 1;
      }
    }
  }
  return summary;
}

function row(label, a, b) {
  return `| ${label} | ${a} | ${b} |`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: compare-runs.mjs <log1> <log2>");
    process.exit(1);
  }
  const [log1Path, log2Path] = args;
  const text1 = await readFile(log1Path, "utf-8");
  const text2 = await readFile(log2Path, "utf-8");
  const a = summarize(parseLog(text1));
  const b = summarize(parseLog(text2));

  console.log("# Agentify Run Comparison\n");
  console.log(`- \`${log1Path}\``);
  console.log(`- \`${log2Path}\`\n`);

  console.log("## Run summary");
  console.log("| Field | Run 1 | Run 2 |");
  console.log("|-------|-------|-------|");
  console.log(row("Model", a.runStart?.model ?? "?", b.runStart?.model ?? "?"));
  console.log(row("Status", a.runEnd?.status ?? "?", b.runEnd?.status ?? "?"));
  console.log(row("Duration (s)", ((a.runEnd?.duration_ms ?? 0) / 1000).toFixed(1), ((b.runEnd?.duration_ms ?? 0) / 1000).toFixed(1)));
  console.log(row("Total turns", a.runEnd?.total_turns ?? "?", b.runEnd?.total_turns ?? "?"));
  console.log(row("Cost (USD)", "$" + (a.runEnd?.total_cost_usd ?? 0).toFixed(4), "$" + (b.runEnd?.total_cost_usd ?? 0).toFixed(4)));
  console.log(row("Map writes", a.mapWrites.length, b.mapWrites.length));
  console.log(row("Gap detected", a.gapTransitions.detected, b.gapTransitions.detected));
  console.log(row("Gap closed", a.gapTransitions.closed, b.gapTransitions.closed));
  console.log(row("Sub-agent spawns", a.subagentSpawns, b.subagentSpawns));
  console.log(row("Tool errors", a.errors, b.errors));
  console.log();

  console.log("## Tool call distribution");
  console.log("| Tool | Run 1 | Run 2 |");
  console.log("|------|-------|-------|");
  const allTools = new Set([...a.toolStarts.keys(), ...b.toolStarts.keys()]);
  for (const tool of [...allTools].sort()) {
    console.log(row(tool, a.toolStarts.get(tool) ?? 0, b.toolStarts.get(tool) ?? 0));
  }
  console.log();

  // Coverage comparison (last map write)
  if (a.mapWrites.length > 0 && b.mapWrites.length > 0) {
    const lastA = a.mapWrites[a.mapWrites.length - 1].coverage_summary;
    const lastB = b.mapWrites[b.mapWrites.length - 1].coverage_summary;
    console.log("## Final coverage");
    console.log("| Field | Run 1 | Run 2 |");
    console.log("|-------|-------|-------|");
    console.log(row("Covered count", lastA?.covered?.length ?? "?", lastB?.covered?.length ?? "?"));
    console.log(row("Gap count", lastA?.gap?.length ?? "?", lastB?.gap?.length ?? "?"));
    console.log(row("Total", lastA?.total ?? 10, lastB?.total ?? 10));
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
