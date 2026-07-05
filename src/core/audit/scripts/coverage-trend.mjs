#!/usr/bin/env node
// coverage-trend.mjs
//
// Read all agentify logs in chronological order and emit a coverage
// trend: a Markdown table (one row per run, one column per dimension)
// or CSV for plotting. With --format=ansi, an ASCII bar chart.
//
// Usage:
//   node coverage-trend.mjs                  # Markdown table
//   node coverage-trend.mjs --format=csv     # CSV
//   node coverage-trend.mjs --format=ansi    # ASCII bar chart
//   node coverage-trend.mjs --log-dir <path> # override log dir

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR_DEFAULT = join(homedir(), ".agentify", "logs", "agentify");
const COVERAGE_DIMS = [
  "D1_topography",
  "D2_module_boundaries",
  "D3_type_contract",
  "D4_conventions",
  "D5_pitfalls",
  "D6_validation",
  "D7_operational",
  "D8_security",
  "D9_process",
  "D10_documentation",
];

let logDir = LOG_DIR_DEFAULT;
let format = "markdown";

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--log-dir" && i + 1 < process.argv.length) {
    logDir = process.argv[++i];
  } else if (process.argv[i] === "--format" && i + 1 < process.argv.length) {
    format = process.argv[++i];
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

async function main() {
  let files;
  try {
    files = await readdir(logDir);
  } catch (err) {
    console.error(`Cannot read log dir: ${logDir}`);
    process.exit(1);
  }
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

  const rows = [];
  for (const f of jsonlFiles) {
    const full = join(logDir, f);
    try {
      const text = await readFile(full, "utf-8");
      const events = parseLog(text);
      let lastMap = null;
      let runId = null;
      for (const e of events) {
        if (e.run_id && !runId) runId = e.run_id;
        if (e.event === "agentify.map_written") {
          const p = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
          lastMap = p?.coverage_summary ?? null;
        }
      }
      if (lastMap) {
        rows.push({ run: f, runId, coverage: lastMap });
      }
    } catch {
      // skip
    }
  }

  if (rows.length === 0) {
    console.log("No agentify runs with map writes found.");
    return;
  }

  if (format === "csv") {
    console.log("run," + COVERAGE_DIMS.join(","));
    for (const r of rows) {
      const cells = COVERAGE_DIMS.map((d) =>
        r.coverage.covered?.includes(d) ? "1" : "0",
      );
      console.log(`${r.run},${cells.join(",")}`);
    }
  } else if (format === "ansi") {
    console.log("Coverage trend (each row is a run, each column is a dimension):\n");
    for (const r of rows) {
      const cells = COVERAGE_DIMS.map((d) =>
        r.coverage.covered?.includes(d) ? "█" : "░",
      );
      console.log(`  ${r.run.slice(0, 20)}  ${cells.join("")}`);
    }
    console.log();
    console.log("Legend: █ = covered, ░ = gap");
    console.log("Columns: D1 D2 D3 D4 D5 D6 D7 D8 D9 D10");
  } else {
    // Markdown
    console.log("# Coverage trend\n");
    console.log(`Source: \`${logDir}\`\n`);
    console.log(`Runs: **${rows.length}**\n`);
    console.log("| Run | " + COVERAGE_DIMS.map((d) => d.replace(/^D\d+_/, "")).join(" | ") + " |");
    console.log("|-----|" + COVERAGE_DIMS.map(() => "---").join("|") + "|");
    for (const r of rows) {
      const cells = COVERAGE_DIMS.map((d) =>
        r.coverage.covered?.includes(d) ? "✓" : "✗",
      );
      console.log(`| ${r.run.slice(0, 24)} | ${cells.join(" | ")} |`);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
