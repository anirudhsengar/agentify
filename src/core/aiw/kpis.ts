// kpis.ts — agentic KPI tracking (the trust gate before AFK).
//
// Per `principles/13-agentic-layer.md` § "Agentic KPIs File" and
// `06-aiws-and-afk.md` § "The AFK Investment Strategy":
//
//   Current Streak:  consecutive AIWs with attempts ≤ 2
//   Longest Streak:  all-time best
//   Plan Size:       median `wc -l <plan_file>` over last 10 runs
//   Diff Size:       median git diff shortstat over last 10 runs
//   Average Presence: mean attempts over last 25 runs
//
//   AFK on chores: 5 consecutive one-attempt ships → earn AFK on chores
//   AFK on bugs:   5 consecutive → earn AFK on bugs
//   AFK on features: 5 consecutive → earn AFK on features
//
// The file is rewritten atomically on every update. The format is a
// human-readable Markdown table; downstream tooling parses it as
// YAML frontmatter + Markdown.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AiwPaths } from "./paths.ts";
import { aiwPaths } from "./paths.ts";
import type { AiwState } from "./state.ts";

export interface KpisSnapshot {
  currentStreak: number;
  longestStreak: number;
  planSizeMedian: number | null;
  planSizeP95: number | null;
  diffSizeMedian: { added: number; removed: number; files: number } | null;
  diffSizeP95: { added: number; removed: number; files: number } | null;
  averagePresence: number;
  attempts: number;
  afkEarned: { chores: boolean; bugs: boolean; features: boolean };
  updatedAt: string;
}

export interface RunRecord {
  /** AIW id. */
  aiwId: string;
  /** "chore" | "bug" | "feature" — drives the AFK class. */
  changeType: "chore" | "bug" | "feature" | "unknown";
  /** ISO 8601 timestamp. */
  at: string;
  /** Total attempts (count of plan + fix phases that ran). */
  attempts: number;
  /** Plan file line count, if a plan was produced. */
  planLines: number | null;
  /** Git shortstat for the run, if computable. */
  diffStat: { added: number; removed: number; files: number } | null;
  /** Whether the run completed on first attempt. */
  oneAttempt: boolean;
}

const HISTORY_LIMIT = 25;
const AFK_THRESHOLD = 5;

/**
 * Append a run record to the KPIs file and recompute the snapshot.
 * Idempotent in shape: if the same `aiwId` appears twice, the
 * second append updates the existing record (by `aiwId`), it doesn't
 * duplicate.
 */
export function recordRun(paths: AiwPaths, record: RunRecord): void {
  const all = readAllRecords(paths);
  const filtered = all.filter((r) => r.aiwId !== record.aiwId);
  filtered.push(record);
  // Cap history to keep the file small.
  const trimmed = filtered.slice(-HISTORY_LIMIT);
  writeAllRecords(paths, trimmed);
  recomputeAndWrite(paths, trimmed);
}

/**
 * Re-read the KPIs file and produce a fresh snapshot.
 */
export function readSnapshot(paths: AiwPaths): KpisSnapshot {
  const records = readAllRecords(paths);
  return computeSnapshot(records);
}

/**
 * Convenience: read the KPIs file at the standard location.
 */
export function readDefaultSnapshot(configDir: string): KpisSnapshot {
  return readSnapshot(aiwPaths(configDir));
}

// ---------------------------------------------------------------------------
// File layout
// ---------------------------------------------------------------------------

interface KpisFile {
  schema_version: number;
  records: RunRecord[];
}

const CURRENT_SCHEMA_VERSION = 1;

function readAllRecords(paths: AiwPaths): RunRecord[] {
  if (!fs.existsSync(paths.kpisFile)) return [];
  try {
    const raw = fs.readFileSync(paths.kpisFile, "utf-8");
    const parsed = parseKpisFile(raw);
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

function writeAllRecords(paths: AiwPaths, records: RunRecord[]): void {
  const file: KpisFile = {
    schema_version: CURRENT_SCHEMA_VERSION,
    records,
  };
  fs.mkdirSync(path.dirname(paths.kpisFile), { recursive: true, mode: 0o700 });
  const tmp = `${paths.kpisFile}.tmp`;
  fs.writeFileSync(tmp, serializeKpisFile(file), { mode: 0o600 });
  fs.renameSync(tmp, paths.kpisFile);
}

function parseKpisFile(raw: string): KpisFile {
  // Strip YAML frontmatter if present.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { schema_version: 1, records: [] };
  // Records are encoded as a JSON array in the body (between frontmatter
  // markers and a "<!-- kpis-md -->" comment that begins the rendered
  // Markdown). For now, we only care about the JSON.
  const body = fmMatch[2] ?? "";
  const jsonMatch = body.match(/<!-- records-json -->\n(\[[\s\S]*?\])/);
  if (!jsonMatch) return { schema_version: 1, records: [] };
  try {
    const records = (JSON.parse(jsonMatch[1]!) as Array<Record<string, unknown>>).map((record) => ({
      aiwId: typeof record.aiwId === "string" ? record.aiwId : "unknown",
      changeType:
        typeof record.changeType === "string"
          ? record.changeType as RunRecord["changeType"]
          : typeof record.classification === "string"
            ? record.classification as RunRecord["changeType"]
            : "unknown",
      at: typeof record.at === "string" ? record.at : "",
      attempts: typeof record.attempts === "number" ? record.attempts : 0,
      planLines: typeof record.planLines === "number" ? record.planLines : null,
      diffStat: typeof record.diffStat === "object" && record.diffStat !== null
        ? record.diffStat as RunRecord["diffStat"]
        : null,
      oneAttempt: record.oneAttempt === true,
    }));
    return { schema_version: 1, records };
  } catch {
    return { schema_version: 1, records: [] };
  }
}

function serializeKpisFile(file: KpisFile): string {
  const snapshot = computeSnapshot(file.records);
  const recordsJson = JSON.stringify(file.records, null, 2);
  const md = renderMarkdown(snapshot);
  return [
    "---",
    "schema_version: " + file.schema_version,
    "updated_at: " + snapshot.updatedAt,
    "---",
    "",
    "<!-- records-json -->",
    recordsJson,
    "",
    "<!-- kpis-md -->",
    "",
    md,
  ].join("\n");
}

function renderMarkdown(s: KpisSnapshot): string {
  const yesNo = (v: boolean): string => (v ? "yes" : "no");
  const lines: string[] = [];
  lines.push("# Agentic KPIs");
  lines.push("");
  lines.push("> Generated by agentify. Source of truth for the AFK trust gate.");
  lines.push("");
  lines.push(`Updated: ${s.updatedAt}`);
  lines.push("");
  lines.push("## Current Streak");
  lines.push(`- Value: ${s.currentStreak}`);
  lines.push("");
  lines.push("## Longest Streak");
  lines.push(`- Value: ${s.longestStreak}`);
  lines.push("");
  lines.push("## Plan Size (last 10)");
  if (s.planSizeMedian !== null) {
    lines.push(`- median: ${s.planSizeMedian} lines`);
    lines.push(`- p95: ${s.planSizeP95 ?? "?"} lines`);
  } else {
    lines.push("- no data yet");
  }
  lines.push("");
  lines.push("## Diff Size (last 10)");
  if (s.diffSizeMedian !== null) {
    lines.push(`- median: +${s.diffSizeMedian.added} / -${s.diffSizeMedian.removed} / ${s.diffSizeMedian.files} files`);
    lines.push(`- p95: +${s.diffSizeP95?.added ?? "?"} / -${s.diffSizeP95?.removed ?? "?"} / ${s.diffSizeP95?.files ?? "?"} files`);
  } else {
    lines.push("- no data yet");
  }
  lines.push("");
  lines.push("## Average Presence (last 25)");
  lines.push(`- attempts: ${s.averagePresence.toFixed(2)}`);
  lines.push("");
  lines.push("## AFK Earned");
  lines.push(`- chores: ${yesNo(s.afkEarned.chores)}`);
  lines.push(`- bugs: ${yesNo(s.afkEarned.bugs)}`);
  lines.push(`- features: ${yesNo(s.afkEarned.features)}`);
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Snapshot computation
// ---------------------------------------------------------------------------

export function computeSnapshot(records: RunRecord[]): KpisSnapshot {
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
  // Current Streak: walk backward from the most recent; count
  // consecutive one-attempt runs.
  let currentStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.oneAttempt) currentStreak += 1;
    else break;
  }
  // Longest Streak: scan all records.
  let longestStreak = 0;
  let runStart = 0;
  for (let i = 0; i <= sorted.length; i++) {
    if (i === sorted.length || !sorted[i]!.oneAttempt) {
      longestStreak = Math.max(longestStreak, i - runStart);
      runStart = i + 1;
    }
  }
  // Plan size over last 10.
  const last10 = sorted.slice(-10);
  const planLines = last10
    .map((r) => r.planLines)
    .filter((n): n is number => typeof n === "number" && n > 0);
  const planSizeMedian = planLines.length > 0 ? median(planLines) : null;
  const planSizeP95 = planLines.length > 0 ? percentile(planLines, 0.95) : null;
  // Diff size over last 10.
  const diffStats = last10
    .map((r) => r.diffStat)
    .filter((s): s is NonNullable<RunRecord["diffStat"]> => s !== null);
  const diffSizeMedian = diffStats.length > 0
    ? {
        added: median(diffStats.map((s) => s.added)),
        removed: median(diffStats.map((s) => s.removed)),
        files: median(diffStats.map((s) => s.files)),
      }
    : null;
  const diffSizeP95 = diffStats.length > 0
    ? {
        added: percentile(diffStats.map((s) => s.added), 0.95),
        removed: percentile(diffStats.map((s) => s.removed), 0.95),
        files: percentile(diffStats.map((s) => s.files), 0.95),
      }
    : null;
  // Average presence over last 25.
  const last25 = sorted.slice(-HISTORY_LIMIT);
  const averagePresence = last25.length > 0
    ? last25.reduce((acc, r) => acc + r.attempts, 0) / last25.length
    : 0;
  // AFK earned — count consecutive one-attempt runs by class.
  const afkEarned = computeZteEarned(sorted);

  return {
    currentStreak,
    longestStreak,
    planSizeMedian,
    planSizeP95,
    diffSizeMedian,
    diffSizeP95,
    averagePresence,
    attempts: sorted.length,
    afkEarned,
    updatedAt: new Date().toISOString(),
  };
}

function computeZteEarned(sorted: RunRecord[]): { chores: boolean; bugs: boolean; features: boolean } {
  const byClass: Record<"chore" | "bug" | "feature", number> = {
    chore: 0,
    bug: 0,
    feature: 0,
  };
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]!;
    if (r.changeType === "chore" || r.changeType === "bug" || r.changeType === "feature") {
      if (r.oneAttempt) {
        byClass[r.changeType] += 1;
      } else {
        break;
      }
    }
  }
  return {
    chores: byClass.chore >= AFK_THRESHOLD,
    bugs: byClass.bug >= AFK_THRESHOLD,
    features: byClass.feature >= AFK_THRESHOLD,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------
// One-shot recompute (used after manual edits to records)
// ---------------------------------------------------------------------------

function recomputeAndWrite(paths: AiwPaths, records: RunRecord[]): void {
  const snapshot = computeSnapshot(records);
  const file: KpisFile = { schema_version: CURRENT_SCHEMA_VERSION, records };
  fs.mkdirSync(path.dirname(paths.kpisFile), { recursive: true, mode: 0o700 });
  const tmp = `${paths.kpisFile}.tmp`;
  fs.writeFileSync(tmp, serializeKpisFile(file), { mode: 0o600 });
  fs.renameSync(tmp, paths.kpisFile);
  // Snapshot is captured as a side-effect of serializeKpisFile.
  void snapshot;
}

// ---------------------------------------------------------------------------
// Convenience: derive a RunRecord from a finished AiwState
// ---------------------------------------------------------------------------

export function recordFromAiw(
  state: AiwState,
  opts?: {
    planLines?: number | null;
    diffStat?: { added: number; removed: number; files: number } | null;
    changeType?: RunRecord["changeType"];
  },
): RunRecord {
  return {
    aiwId: state.aiw_id,
    changeType: opts?.changeType ?? "unknown",
    at: state.ended_at ?? state.started_at,
    attempts: state.attempts,
    planLines: opts?.planLines ?? null,
    diffStat: opts?.diffStat ?? null,
    oneAttempt: state.attempts <= 1 && state.status === "completed",
  };
}