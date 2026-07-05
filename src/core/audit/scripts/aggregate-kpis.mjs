#!/usr/bin/env node
// aggregate-kpis.mjs
//
// Aggregate key performance indicators across all agentify runs in
// the log dir. Computes: total runs, success rate, mean duration,
// mean cost, per-dimension coverage rate, per-tool call distribution.
//
// Usage:
//   node aggregate-kpis.mjs                    # default log dir
//   node aggregate-kpis.mjs --log-dir <path>   # override log dir
//
// Output: a single-page Markdown report.

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR_DEFAULT = join(homedir(), ".agentify", "logs", "agentify");

let logDir = LOG_DIR_DEFAULT;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--log-dir" && i + 1 < process.argv.length) {
    logDir = process.argv[++i];
  }
}

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
  const s = { status: null, duration_ms: 0, cost: 0, covered: 0, gap: 0, total: 0, tools: new Map() };
  for (const e of events) {
    if (e.event === "agentify.run_end") {
      const p = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      s.status = p?.status ?? null;
      s.duration_ms = p?.duration_ms ?? 0;
      s.cost = p?.total_cost_usd ?? 0;
      if (p?.coverage) {
        s.covered = p.coverage.covered ?? 0;
        s.gap = p.coverage.gap ?? 0;
        s.total = p.coverage.total ?? 10;
      }
    } else if (e.event === "agentify.session_event") {
      const inner = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      const ev = inner?.event;
      if (ev?.type === "tool_execution_start") {
        const t = ev.toolName ?? "?";
        s.tools.set(t, (s.tools.get(t) ?? 0) + 1);
      }
    }
  }
  return s;
}

async function main() {
  let files;
  try {
    files = await readdir(logDir);
  } catch (err) {
    console.error(`Cannot read log dir: ${logDir}`);
    process.exit(1);
  }
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const summaries = [];
  for (const f of jsonlFiles) {
    const full = join(logDir, f);
    try {
      const text = await readFile(full, "utf-8");
      summaries.push(summarize(parseLog(text)));
    } catch {
      // skip unreadable
    }
  }

  if (summaries.length === 0) {
    console.log(`# Agentify Aggregate KPIs\n\nNo runs found in \`${logDir}\`.\n`);
    return;
  }

  // Compute aggregates.
  const totalRuns = summaries.length;
  const successCount = summaries.filter((s) => s.status === "success").length;
  const successRate = ((successCount / totalRuns) * 100).toFixed(1);
  const meanDuration =
    summaries.reduce((a, s) => a + s.duration_ms, 0) / totalRuns / 1000;
  const meanCost = summaries.reduce((a, s) => a + s.cost, 0) / totalRuns;
  const meanCovered =
    summaries.reduce((a, s) => a + s.covered, 0) / totalRuns;
  const meanGap = summaries.reduce((a, s) => a + s.gap, 0) / totalRuns;

  // Per-tool aggregate.
  const toolTotals = new Map();
  for (const s of summaries) {
    for (const [t, n] of s.tools) {
      toolTotals.set(t, (toolTotals.get(t) ?? 0) + n);
    }
  }

  console.log(`# Agentify Aggregate KPIs\n`);
  console.log(`Source: \`${logDir}\`\n`);
  console.log(`Runs analyzed: **${totalRuns}**\n`);
  console.log(`## Headline metrics`);
  console.log(`- **Success rate:** ${successCount}/${totalRuns} (${successRate}%)`);
  console.log(`- **Mean duration:** ${meanDuration.toFixed(1)}s`);
  console.log(`- **Mean cost:** $${meanCost.toFixed(4)}`);
  console.log(`- **Mean coverage:** ${meanCovered.toFixed(1)}/10 dimensions`);
  console.log(`- **Mean gap:** ${meanGap.toFixed(1)} dimensions\n`);

  console.log(`## Status distribution`);
  const statusCounts = new Map();
  for (const s of summaries) {
    const st = s.status ?? "unknown";
    statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
  }
  for (const [st, n] of statusCounts) {
    console.log(`- ${st}: ${n} (${((n / totalRuns) * 100).toFixed(1)}%)`);
  }
  console.log();

  console.log(`## Tool call distribution (across all runs)`);
  const toolTotal = [...toolTotals.values()].reduce((a, b) => a + b, 0);
  for (const [t, n] of [...toolTotals.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = toolTotal > 0 ? ((n / toolTotal) * 100).toFixed(1) : "0.0";
    console.log(`- ${t}: ${n} (${pct}%)`);
  }

  // Class 3 orchestrator + AIW workflow surface (per PLAN-class2-grade2.md § 12.6).
  // Reads ~/.agentify/orchestrator/{events.jsonl, workflows/<id>/events.jsonl}
  // and ~/.agentify/aiw/<id>/aiw_state.json to roll up fleet stats.
  await aggregateOrchestratorKpis();
}

/**
 * Read the orchestrator + workflow state on disk and emit a
 * section to stdout. Best-effort: missing files = empty section.
 */
async function aggregateOrchestratorKpis() {
  const { homedir } = await import("node:os");
  const orchRoot = join(homedir(), ".agentify", "orchestrator");
  const aiwRoot = join(homedir(), ".agentify", "aiw");

  let orchEvents = 0;
  let orchTurns = 0;
  let orchCost = 0;
  try {
    const text = await readFile(join(orchRoot, "events.jsonl"), "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (e.kind === "chat_ended") {
          orchEvents += 1;
          if (typeof e.fields?.turns === "number") orchTurns += e.fields.turns;
          if (typeof e.fields?.costUsd === "number") orchCost += e.fields.costUsd;
        }
      } catch { /* skip */ }
    }
  } catch { /* no orchestrator on this machine */ }

  // Workflow runs.
  let workflowRuns = 0;
  let workflowCompleted = 0;
  let workflowFailed = 0;
  let workflowCost = 0;
  try {
    const dirs = await readdir(join(orchRoot, "workflows"));
    for (const d of dirs) {
      try {
        const st = JSON.parse(await readFile(join(orchRoot, "workflows", d, "workflow_run.json"), "utf-8"));
        workflowRuns += 1;
        if (st.status === "completed") workflowCompleted += 1;
        else if (st.status === "failed") workflowFailed += 1;
        if (typeof st.cost_usd === "number") workflowCost += st.cost_usd;
      } catch { /* skip */ }
    }
  } catch { /* no workflows */ }

  // AIWs.
  let aiwRuns = 0;
  let aiwRunning = 0;
  let aiwCompleted = 0;
  let aiwFailed = 0;
  try {
    const dirs = await readdir(aiwRoot);
    for (const d of dirs) {
      try {
        const st = JSON.parse(await readFile(join(aiwRoot, d, "aiw_state.json"), "utf-8"));
        aiwRuns += 1;
        if (st.status === "running") aiwRunning += 1;
        else if (st.status === "completed") aiwCompleted += 1;
        else if (st.status === "failed") aiwFailed += 1;
      } catch { /* skip */ }
    }
  } catch { /* no aiws */ }

  if (orchEvents === 0 && workflowRuns === 0 && aiwRuns === 0) return;

  console.log(`\n## Class 3 fleet surface\n`);
  console.log(`- **Orchestrator chats:** ${orchEvents} · ${orchTurns} turns · $${orchCost.toFixed(4)}`);
  console.log(`- **Workflow runs:** ${workflowRuns} · ${workflowCompleted} completed · ${workflowFailed} failed · $${workflowCost.toFixed(4)}`);
  console.log(`- **AIWs:** ${aiwRuns} · ${aiwRunning} running · ${aiwCompleted} completed · ${aiwFailed} failed`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
