// agent-expert.ts — the ExpertRegistry: ACT → LEARN → REUSE for
// agentify's per-codebase experts.
//
// Per `principles/09-agent-experts.md` and `docs/11-expert-prompts.md`,
// each expert is a directory under `<cwd>/.pi/prompts/experts/<domain>/`
// containing:
//
//   - expertise.yaml     — the mental model (≤1000 lines)
//   - question.md        — read-only query (mandatory)
//   - self-improve.md    — ACT → LEARN → REUSE syncer (mandatory)
//   - plan.md            — expertise-aware planner (optional)
//   - plan_build_improve.md — full chain (optional)
//
// This module exposes:
//   - `ExpertRegistry.fromCwd(cwd)` — scan + parse all experts
//   - `parseExpertiseYaml(path)` — parse + validate the YAML
//   - `runSelfImprove(expert, cwd, runtime)` — run the LEARN phase
//     (sync expertise.yaml against the code)
//   - `runQuestion(expert, cwd, question, runtime)` — run the REUSE
//     phase (answer a question from the mental model)
//
// The ACT phase is just normal `/experts:<domain>:plan` or
// `/experts:<domain>:plan_build_improve` invocations; this module
// covers the LEARN and REUSE halves.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpertDomain {
  /** Domain name (matches the directory name). */
  domain: string;
  /** Path to the expert directory. */
  dir: string;
  /** Path to expertise.yaml. */
  expertisePath: string;
  /** Path to question.md. */
  questionPath: string;
  /** Path to self-improve.md. */
  selfImprovePath: string;
  /** Path to plan.md (if present). */
  planPath: string | null;
  /** Path to plan_build_improve.md (if present). */
  planBuildImprovePath: string | null;
  /** Parsed frontmatter from question.md. */
  description: string;
  /** ISO date from expertise.yaml's `last_updated` (if parseable). */
  lastUpdated: string | null;
}

export interface ExpertiseYaml {
  domain: string;
  last_updated?: string;
  overview?: { description?: string; key_files?: Array<{ path: string; line_range?: [number, number]; purpose?: string }> };
  key_types?: Array<{ name: string; path: string; purpose?: string }>;
  patterns?: Array<{ name: string; description?: string; example_ref?: string }>;
  pitfalls?: Array<{ risk: string; consequence?: string; reference?: string }>;
  conventions?: string[];
  best_practices?: string[];
  known_issues?: string[];
  testing?: { command?: string; test_paths?: string[] };
  primary_paths?: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ExpertRegistry {
  private readonly experts: ExpertDomain[];

  private constructor(experts: ExpertDomain[]) {
    this.experts = experts;
  }

  static fromCwd(
    cwd: string,
    stateDir: string = ".pi",
  ): ExpertRegistry {
    const expertsDir = path.join(cwd, stateDir, "prompts", "experts");
    if (!fs.existsSync(expertsDir)) return new ExpertRegistry([]);
    const out: ExpertDomain[] = [];
    for (const entry of fs.readdirSync(expertsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(expertsDir, entry.name);
      const expertisePath = path.join(dir, "expertise.yaml");
      if (!fs.existsSync(expertisePath)) continue;
      const questionPath = path.join(dir, "question.md");
      const selfImprovePath = path.join(dir, "self-improve.md");
      const planPath = fs.existsSync(path.join(dir, "plan.md")) ? path.join(dir, "plan.md") : null;
      const planBuildImprovePath = fs.existsSync(path.join(dir, "plan_build_improve.md")) ? path.join(dir, "plan_build_improve.md") : null;
      const { description } = parseFrontmatter(questionPath);
      let lastUpdated: string | null = null;
      try {
        const yaml = parseExpertiseYaml(expertisePath);
        lastUpdated = yaml.last_updated ?? null;
      } catch {
        // ignore — invalid YAML is reported elsewhere.
      }
      out.push({
        domain: entry.name,
        dir,
        expertisePath,
        questionPath,
        selfImprovePath,
        planPath,
        planBuildImprovePath,
        description,
        lastUpdated,
      });
    }
    return new ExpertRegistry(out);
  }

  /** All discovered experts, sorted by domain name. */
  list(): ExpertDomain[] {
    return [...this.experts].sort((a, b) => a.domain.localeCompare(b.domain));
  }

  /** Look up by domain name. */
  get(domain: string): ExpertDomain | null {
    return this.experts.find((e) => e.domain === domain) ?? null;
  }
}

// ---------------------------------------------------------------------------
// YAML parsing (minimal, no external dep)
// ---------------------------------------------------------------------------

/**
 * Tiny YAML reader. Handles the subset we need:
 *   - key: value (strings, numbers, booleans)
 *   - arrays via `- item`
 *   - nested objects via 2-space indent
 *
 * For full YAML support we could add `yaml` as a dep, but the
 * agentify project's `expertise.yaml` files follow a strict shape
 * and this minimal parser keeps us at zero new deps.
 */
export function parseExpertiseYaml(filePath: string): ExpertiseYaml {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseExpertiseYamlText(raw);
}

export function parseExpertiseYamlText(raw: string): ExpertiseYaml {
  // Indent-based recursive descent. We pre-tokenize lines, then walk
  // with a position cursor. Each parse call returns the parsed value
  // and the new cursor position.

  interface Line {
    indent: number;
    body: string;
  }

  const lines: Line[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    lines.push({ indent, body: rawLine.replace(/^ */, "") });
  }

  function parseValue(start: number, _parentIndent: number): { value: unknown; end: number } {
    // Caller guarantees lines[start] exists and has indent > parentIndent.
    const first = lines[start]!;
    const firstBody = first.body;

    // Array: lines starting with `- ` at this indent.
    if (firstBody.startsWith("- ")) {
      const arr: unknown[] = [];
      let i = start;
      while (i < lines.length && lines[i]!.indent === first.indent && lines[i]!.body.startsWith("- ")) {
        const itemBody = lines[i]!.body.slice(2);
        // If itemBody is `key: value` or `key:`, this is an object item.
        // If it's a scalar, push it directly.
        const m = itemBody.match(/^([a-zA-Z_][\w_-]*):\s*(.*)$/);
        if (!m) {
          arr.push(parseScalar(itemBody));
          i += 1;
        } else {
          const obj: Record<string, unknown> = {};
          const key = m[1]!;
          const rest = m[2] ?? "";
          const itemIndent = lines[i]!.indent;
          if (rest === "") {
            // `- key:` followed by indented sub-fields. Sub-fields are
            // at indent > itemIndent. Recurse with a fresh object.
            // Look ahead: if next line is a deeper-indent `key:` or `- `,
            // parse it as an object; otherwise leave empty.
            const next = lines[i + 1];
            if (next && next.indent > itemIndent) {
              const sub = parseObject(i + 1, next.indent);
              obj[key] = sub.value;
              i = sub.end;
            } else {
              obj[key] = {};
              i += 1;
            }
          } else if (rest.startsWith("[") && rest.endsWith("]")) {
            const inner = rest.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
            obj[key] = inner.map((s) => parseScalar(s));
            // Look ahead for additional sub-fields at deeper indent.
            const next = lines[i + 1];
            if (next && next.indent > itemIndent && !next.body.startsWith("- ")) {
              const sub = parseObject(i + 1, next.indent);
              Object.assign(obj, sub.value as Record<string, unknown>);
              i = sub.end;
            } else {
              i += 1;
            }
            arr.push(obj);
            continue;
          } else {
            obj[key] = parseScalar(rest);
            // Look ahead for additional sub-fields at deeper indent.
            const next = lines[i + 1];
            if (next && next.indent > itemIndent && !next.body.startsWith("- ")) {
              const sub = parseObject(i + 1, next.indent);
              Object.assign(obj, sub.value as Record<string, unknown>);
              i = sub.end;
            } else {
              i += 1;
            }
            arr.push(obj);
            continue;
          }
          arr.push(obj);
        }
      }
      return { value: arr, end: i };
    }

    // Object: lines starting with `key:` at this indent.
    return parseObject(start, first.indent);
  }

  function parseObject(start: number, indent: number): { value: Record<string, unknown>; end: number } {
    const obj: Record<string, unknown> = {};
    let i = start;
    while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.body.startsWith("- ")) {
      const line = lines[i]!;
      const m = line.body.match(/^([a-zA-Z_][\w_-]*):\s*(.*)$/);
      if (!m) {
        i += 1;
        continue;
      }
      const key = m[1]!;
      const rest = m[2] ?? "";
      if (rest === "") {
        // Look ahead: is the next line an array item at deeper indent,
        // or another key:value at the same indent? Either way, recurse.
        const next = lines[i + 1];
        if (!next || next.indent <= indent) {
          // Empty value: just an empty string.
          obj[key] = "";
          i += 1;
        } else {
          const sub = parseValue(i + 1, indent);
          obj[key] = sub.value;
          i = sub.end;
        }
      } else if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
        obj[key] = inner.map((s) => parseScalar(s));
        i += 1;
      } else {
        obj[key] = parseScalar(rest);
        i += 1;
      }
    }
    return { value: obj, end: i };
  }

  if (lines.length === 0) return {} as ExpertiseYaml;
  // Top-level must be an object (per the YAML spec's expertise.yaml shape).
  const result = parseObject(0, lines[0]!.indent);
  return result.value as unknown as ExpertiseYaml;
}

function parseScalar(s: string): unknown {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "") return "";
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  // Strip surrounding quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFrontmatter(filePath: string): { description: string } {
  if (!fs.existsSync(filePath)) return { description: "" };
  const raw = fs.readFileSync(filePath, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { description: "" };
  const block = m[1] ?? "";
  const descMatch = block.match(/^description:\s*(.+)$/m);
  return { description: descMatch?.[1]?.trim() ?? "" };
}

// ---------------------------------------------------------------------------
// ACT → LEARN → REUSE
// ---------------------------------------------------------------------------

export interface SelfImproveResult {
  expert: string;
  changed: boolean;
  /** ISO date the YAML was last_updated before. */
  previousLastUpdated: string | null;
  /** ISO date the YAML was last_updated after. */
  newLastUpdated: string;
  /** Number of lines in the YAML before. */
  linesBefore: number;
  /** Number of lines in the YAML after. */
  linesAfter: number;
  /** Diff summary (e.g. "added 2 patterns, removed 1 pitfall"). */
  summary: string;
  /** Validation: did the YAML still parse? */
  valid: boolean;
  /** Truncated stdout from the syncer subprocess. */
  syncerOutput?: string;
}

export interface QuestionResult {
  expert: string;
  question: string;
  answer: string;
  /** Citations to file:line refs from the expertise. */
  citations: string[];
  /** Confidence flag from the syncer (e.g. "low" if contradictions found). */
  confidence: "high" | "medium" | "low";
}

export interface StaleExpert {
  domain: string;
  expert: ExpertDomain;
  lastUpdated: string | null;
  latestChangedPath: string | null;
  latestChangedAt: string | null;
  checkedPathCount: number;
  reason: string;
}

export interface StaleExpertOptions {
  maxFilesPerExpert?: number;
}

// ---------------------------------------------------------------------------
// Self-improve driver
// ---------------------------------------------------------------------------

/**
 * Run the LEARN phase for an expert. Spawns `pi -p <self-improve.md>`
 * (or the caller-provided syncer) and updates `last_updated` to today.
 *
 * The syncer is responsible for the actual diff-and-update logic
 * (per `docs/11-expert-prompts.md` § "self-improve.md"). This
 * function is the seam: it loads the YAML, calls the syncer, and
 * re-reads the YAML to compute the diff.
 */
export interface SelfImproveOptions {
  /** Optional override for the syncer (e.g. for tests). */
  syncer?: SelfImproveSyncer;
  /** ISO date string for last_updated (defaults to today). */
  todayIso?: string;
  /** Logger callback. */
  log?: (msg: string) => void;
  /**
   * Config dir for resolving the lite slot. Required to use the
   * lite-slot model override; if absent, the syncer falls back to
   * `pi -p`'s default model.
   */
  configDir?: string;
  /**
   * Slot hint to pass through to the syncer. Defaults to "lite".
   * Provider is `string` (not the strict AgentifyProvider union)
   * because the subprocess pass-through doesn't enforce the union.
   */
  modelSlot?: { provider: string; model: string };
}

export type SelfImproveSyncer = (args: {
  cwd: string;
  expert: ExpertDomain;
  yaml: ExpertiseYaml;
  todayIso: string;
  configDir?: string;
  modelSlot?: { provider: string; model: string };
}) => Promise<{ stdout: string; changed: boolean; summary: string }>;

export async function runSelfImprove(
  expert: ExpertDomain,
  cwd: string,
  options: SelfImproveOptions = {},
): Promise<SelfImproveResult> {
  const todayIso = options.todayIso ?? new Date().toISOString();
  const before = fs.readFileSync(expert.expertisePath, "utf-8");
  const linesBefore = before.split("\n").length;
  let prevLastUpdated: string | null = null;
  let prevYaml: ExpertiseYaml | null = null;
  try {
    prevYaml = parseExpertiseYamlText(before);
    prevLastUpdated = prevYaml.last_updated ?? null;
  } catch {
    // Invalid YAML — still attempt to self-improve.
  }

  options.log?.(`self-improve: ${expert.domain} (${linesBefore} lines)`);

  const syncer = options.syncer ?? defaultSelfImproveSyncer;
  const result = await syncer({
    cwd,
    expert,
    yaml: prevYaml ?? { domain: expert.domain },
    todayIso,
    configDir: options.configDir,
    modelSlot: options.modelSlot,
  });

  // After the syncer runs, re-read the YAML to compute the diff.
  const after = fs.existsSync(expert.expertisePath)
    ? fs.readFileSync(expert.expertisePath, "utf-8")
    : before;
  const linesAfter = after.split("\n").length;

  let valid = false;
  let newYaml: ExpertiseYaml | null = null;
  try {
    newYaml = parseExpertiseYamlText(after);
    valid = true;
  } catch {
    valid = false;
  }

  return {
    expert: expert.domain,
    changed: result.changed || before !== after,
    previousLastUpdated: prevLastUpdated,
    newLastUpdated: newYaml?.last_updated ?? todayIso,
    linesBefore,
    linesAfter,
    summary: result.summary,
    valid,
    syncerOutput: result.stdout,
  };
}

async function defaultSelfImproveSyncer(args: {
  cwd: string;
  expert: ExpertDomain;
  yaml: ExpertiseYaml;
  todayIso: string;
  configDir?: string;
  modelSlot?: { provider: string; model: string };
}): Promise<{ stdout: string; changed: boolean; summary: string }> {
  // The default syncer spawns `pi -p <self-improve.md>`. This keeps
  // the LEARN loop deterministic on real Pi installations while
  // remaining testable via the `syncer` override.
  //
  // Phase 3: if `modelSlot` is provided, set the env var
  // `AGENTIFY_LEARN_MODEL=<provider>/<id>` so downstream `pi -p`
  // implementations can pick the right model. (Some `pi` builds honor
  // this; others ignore it — the fallback is `pi -p`'s default.)
  return new Promise((resolve, reject) => {
    let stdout = "";
    try {
      const bin = process.env["PI_BIN"] ?? "pi";
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (args.modelSlot) {
        env["AGENTIFY_LEARN_MODEL"] = `${args.modelSlot.provider}/${args.modelSlot.model}`;
      }
      const proc = spawn(bin, ["-p", args.expert.selfImprovePath, "--cwd", args.cwd], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
      proc.stderr.on("data", () => { /* swallow */ });
      proc.on("error", reject);
      proc.on("close", (code) => {
        const changed = args.yaml.last_updated !== args.todayIso;
        resolve({
          stdout,
          changed,
          summary: code === 0 ? "synced" : `syncer exited with code ${code}`,
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Question driver (REUSE without coding)
// ---------------------------------------------------------------------------

export interface QuestionOptions {
  /** Optional override for the answerer (e.g. for tests). */
  answerer?: QuestionAnswerer;
  /**
   * Config dir for resolving the lite slot. Required to use the
   * lite-slot model override.
   */
  configDir?: string;
  /** Slot hint to pass through to the answerer. Defaults to "lite". */
  modelSlot?: { provider: string; model: string };
}

export type QuestionAnswerer = (args: {
  cwd: string;
  expert: ExpertDomain;
  question: string;
  configDir?: string;
  modelSlot?: { provider: string; model: string };
}) => Promise<{ answer: string; citations: string[]; confidence: "high" | "medium" | "low" }>;

export async function runQuestion(
  expert: ExpertDomain,
  question: string,
  cwd: string,
  options: QuestionOptions = {},
): Promise<QuestionResult> {
  const answerer = options.answerer ?? defaultQuestionAnswerer;
  const r = await answerer({
    cwd,
    expert,
    question,
    configDir: options.configDir,
    modelSlot: options.modelSlot,
  });
  return {
    expert: expert.domain,
    question,
    answer: r.answer,
    citations: r.citations,
    confidence: r.confidence,
  };
}

async function defaultQuestionAnswerer(args: {
  cwd: string;
  expert: ExpertDomain;
  question: string;
  configDir?: string;
  modelSlot?: { provider: string; model: string };
}): Promise<{ answer: string; citations: string[]; confidence: "high" | "medium" | "low" }> {
  return new Promise((resolve, reject) => {
    try {
      const bin = process.env["PI_BIN"] ?? "pi";
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (args.modelSlot) {
        env["AGENTIFY_LEARN_MODEL"] = `${args.modelSlot.provider}/${args.modelSlot.model}`;
      }
      const proc = spawn(bin, ["-p", args.expert.questionPath, args.question, "--cwd", args.cwd], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let stdout = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
      proc.stderr.on("data", () => { /* swallow */ });
      proc.on("error", reject);
      proc.on("close", () => {
        const citations = extractCitations(stdout);
        const confidence: "high" | "medium" | "low" = stdout.toLowerCase().includes("low confidence")
          ? "low"
          : citations.length > 0
            ? "high"
            : "medium";
        resolve({ answer: stdout.trim(), citations, confidence });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function extractCitations(text: string): string[] {
  // Match `path/file.ts:NN` style references (per `principles/09-agent-experts.md`
  // recommendation: "Always cite lines").
  const re = /[\w./-]+\.[a-z]+:\d+/g;
  const found = text.match(re) ?? [];
  return [...new Set(found)].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Auto-trigger: schedule a self-improve after AIW completion
// ---------------------------------------------------------------------------

const DEFAULT_STALE_SCAN_FILE_LIMIT = 500;

function stripLineRef(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((v) => stripLineRef(v.trim())).filter(Boolean))];
}

function expertOwnedPaths(yaml: ExpertiseYaml): string[] {
  const primaryPaths = Array.isArray(yaml.primary_paths) ? yaml.primary_paths : [];
  const overviewKeyFiles = Array.isArray(yaml.overview?.key_files) ? yaml.overview!.key_files! : [];
  const keyTypes = Array.isArray(yaml.key_types) ? yaml.key_types : [];
  const patternRefs = Array.isArray(yaml.patterns) ? yaml.patterns : [];
  const pitfallRefs = Array.isArray(yaml.pitfalls) ? yaml.pitfalls : [];
  const testPaths = Array.isArray(yaml.testing?.test_paths) ? yaml.testing!.test_paths! : [];
  return uniqueNonEmpty([
    ...primaryPaths,
    ...overviewKeyFiles.map((kf) => kf.path),
    ...keyTypes.map((kt) => kt.path),
    ...patternRefs.map((p) => p.example_ref ?? ""),
    ...pitfallRefs.map((p) => p.reference ?? ""),
    ...testPaths,
  ]);
}

function resolveInsideCwd(cwd: string, relPath: string): string | null {
  const absolute = path.resolve(cwd, relPath);
  const relative = path.relative(cwd, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

function toPosixRel(cwd: string, absolute: string): string {
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

/**
 * Match a known state-dir prefix for an expert directory. Tries
 * each premium state dir in dispatch order
 * (`.claude/agentify` → `.agents/agentify` → `.pi/agentify` →
 * universal `.agents/agentify`) plus the legacy `.pi/` mapping
 * for backward compat.
 */
const KNOWN_STATE_DIRS = [
  ".claude/agentify",
  ".agents/agentify",
  ".pi/agentify",
  ".pi",
] as const;

function repoRootForExpert(expert: ExpertDomain): string | null {
  for (const stateDir of KNOWN_STATE_DIRS) {
    const suffix = path.join(stateDir, "prompts", "experts", expert.domain);
    if (expert.dir.endsWith(suffix)) {
      return expert.dir.slice(0, -suffix.length).replace(/[\\/]+$/, "");
    }
  }
  return null;
}

function normalizeRepoPath(value: string, cwd: string | null): string {
  const stripped = stripLineRef(value.trim());
  if (cwd !== null && path.isAbsolute(stripped)) {
    const relative = path.relative(cwd, stripped);
    if (relative === "") return "";
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join("/").replace(/\/+$/, "");
    }
  }
  return stripped.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function repoPathsOverlap(left: string, right: string): boolean {
  if (left === "" || right === "") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function collectExistingFiles(cwd: string, relPath: string, maxFiles: number, out: string[]): void {
  if (out.length >= maxFiles) return;
  const absolute = resolveInsideCwd(cwd, relPath);
  if (absolute === null || !fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    out.push(absolute);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= maxFiles) return;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    collectExistingFiles(cwd, path.join(relPath, entry.name), maxFiles, out);
  }
}

/**
 * Return the experts whose `primary_paths` overlap the AIW's
 * `touched_paths`. Used by the auto-trigger to schedule LEARN
 * runs after a workflow completes.
 */
export function expertsTouchedBy(
  registry: ExpertRegistry,
  touchedPaths: string[],
): ExpertDomain[] {
  const out: ExpertDomain[] = [];
  for (const expert of registry.list()) {
    let yaml: ExpertiseYaml;
    try {
      yaml = parseExpertiseYaml(expert.expertisePath);
    } catch {
      continue;
    }
    const owned = expertOwnedPaths(yaml);
    if (owned.length === 0) continue;
    const cwd = repoRootForExpert(expert);
    const normalizedTouched = touchedPaths.map((tp) => normalizeRepoPath(tp, cwd));
    const normalizedOwned = owned.map((op) => normalizeRepoPath(op, cwd));
    const overlaps = normalizedTouched.some((tp) => normalizedOwned.some((op) => repoPathsOverlap(tp, op)));
    if (overlaps) out.push(expert);
  }
  return out;
}

/**
 * Return experts whose referenced repository files are newer than
 * `expertise.yaml`'s `last_updated`. This is deterministic staleness
 * detection for refresh loops; the self-improve prompt still owns the
 * actual content update.
 */
export function findStaleExperts(
  registry: ExpertRegistry,
  cwd: string,
  options: StaleExpertOptions = {},
): StaleExpert[] {
  const maxFiles = options.maxFilesPerExpert ?? DEFAULT_STALE_SCAN_FILE_LIMIT;
  const stale: StaleExpert[] = [];

  for (const expert of registry.list()) {
    let yaml: ExpertiseYaml;
    try {
      yaml = parseExpertiseYaml(expert.expertisePath);
    } catch {
      stale.push({
        domain: expert.domain,
        expert,
        lastUpdated: null,
        latestChangedPath: null,
        latestChangedAt: null,
        checkedPathCount: 0,
        reason: "expertise.yaml is not parseable",
      });
      continue;
    }

    const owned = expertOwnedPaths(yaml);
    const files: string[] = [];
    for (const ownedPath of owned) {
      collectExistingFiles(cwd, ownedPath, maxFiles, files);
      if (files.length >= maxFiles) break;
    }

    const lastUpdated = yaml.last_updated ?? expert.lastUpdated;
    const lastUpdatedMs = lastUpdated ? Date.parse(lastUpdated) : Number.NaN;
    if (!Number.isFinite(lastUpdatedMs)) {
      stale.push({
        domain: expert.domain,
        expert,
        lastUpdated: lastUpdated ?? null,
        latestChangedPath: files[0] ? toPosixRel(cwd, files[0]) : null,
        latestChangedAt: files[0] ? fs.statSync(files[0]).mtime.toISOString() : null,
        checkedPathCount: files.length,
        reason: "expertise.yaml last_updated is missing or invalid",
      });
      continue;
    }

    let latestPath: string | null = null;
    let latestMtime = 0;
    for (const file of files) {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestPath = file;
      }
    }

    if (latestPath !== null && latestMtime > lastUpdatedMs) {
      stale.push({
        domain: expert.domain,
        expert,
        lastUpdated,
        latestChangedPath: toPosixRel(cwd, latestPath),
        latestChangedAt: new Date(latestMtime).toISOString(),
        checkedPathCount: files.length,
        reason: "referenced repository file is newer than expertise.yaml last_updated",
      });
    }
  }

  return stale.sort((a, b) => a.domain.localeCompare(b.domain));
}
