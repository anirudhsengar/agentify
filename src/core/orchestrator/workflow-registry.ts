// workflow-registry.ts — discover, parse, and format workflow specs.
//
// Mirrors `SubagentRegistry` (discover, normalize, format-for-prompt).
// Workflows are JSON files at:
//   - src/core/orchestrator/workflows/*.json (packaged starter library)
//   - <configDir>/workflows/*.json           (user-level)
//   - <cwd>/.pi/workflows/*.json             (project; highest precedence)
//
// JSON is intentionally a stand-in for YAML — JSON is a strict
// subset of YAML, no parser dep is required, and TypeBox validation
// is uniform across `run_workflow` and `compose_workflow`. The plan
// calls out JSON as the storage format (`docs/PLAN-class3-grade2.md`).
//
// Every spec on disk is validated at parse time. Invalid specs are
// logged via `errors[]` (mirroring SubagentRegistry) and excluded
// from the active registry. The orchestrator's prompt sees only
// valid specs.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigDir } from "../agentify-config.ts";
import {
  checkWorkflowStructural,
  validateWorkflowSpec,
  type WorkflowSpec,
} from "./workflow-spec.ts";

export interface WorkflowDiscoveryResult {
  workflows: WorkflowSpec[];
  packagedWorkflowsDir: string | null;
  projectWorkflowsDir: string | null;
  userWorkflowsDir: string | null;
  errors: string[];
  /** path → WorkflowSpec provenance. */
  sources: Record<string, { filePath: string; source: "packaged" | "user" | "project" }>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_WORKFLOWS_DIR = path.join(HERE, "workflows");

/** Walk up from cwd looking for the nearest `.pi/workflows/` directory. */
function findNearestProjectWorkflowsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "workflows");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not present
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function loadSpecFromFile(filePath: string): {
  spec: WorkflowSpec | null;
  errors: string[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { spec: null, errors: [`cannot read ${filePath}: ${(err as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { spec: null, errors: [`invalid JSON in ${filePath}: ${(err as Error).message}`] };
  }
  const validation = validateWorkflowSpec(parsed);
  if (!validation.ok || !validation.value) {
    return { spec: null, errors: validation.errors.map((e) => `${filePath}: ${e}`) };
  }
  return { spec: validation.value, errors: [] };
}

function loadSpecsFromDir(
  dir: string,
  source: "packaged" | "user" | "project",
  out: WorkflowDiscoveryResult,
): void {
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    out.errors.push(`cannot read ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    const loaded = loadSpecFromFile(filePath);
    if (loaded.spec) {
      const name = loaded.spec.name;
      if (out.sources[name]) {
        // A later scan tier wins; track the override for provenance.
        out.errors.push(
          `duplicate workflow name '${name}' from ${filePath} (overrode ${out.sources[name]!.filePath})`,
        );
        out.workflows = out.workflows.filter((spec) => spec.name !== name);
      }
      out.workflows.push(loaded.spec);
      out.sources[name] = { filePath, source };
    } else {
      out.errors.push(...loaded.errors);
    }
  }
}

/**
 * Discover all workflows. User-level first, project-level second;
 * project wins on conflict (project scan happens last and replaces).
 */
export function discoverWorkflows(cwd: string, configDir = defaultConfigDir()): WorkflowDiscoveryResult {
  const result: WorkflowDiscoveryResult = {
    workflows: [],
    packagedWorkflowsDir: null,
    projectWorkflowsDir: null,
    userWorkflowsDir: null,
    errors: [],
    sources: {},
  };

  const packagedWorkflowsDir = PACKAGED_WORKFLOWS_DIR;
  const userWorkflowsDir = path.join(configDir, "workflows");
  const projectWorkflowsDir = findNearestProjectWorkflowsDir(cwd);
  result.packagedWorkflowsDir = packagedWorkflowsDir;
  result.userWorkflowsDir = userWorkflowsDir;
  result.projectWorkflowsDir = projectWorkflowsDir;

  loadSpecsFromDir(packagedWorkflowsDir, "packaged", result);
  loadSpecsFromDir(userWorkflowsDir, "user", result);
  if (projectWorkflowsDir) {
    loadSpecsFromDir(projectWorkflowsDir, "project", result);
  }

  return result;
}

/**
 * Format the registry for the orchestrator's prompt. Returns a
 * compact Markdown table the LLM can scan.
 */
export function formatRegistryForPrompt(specs: WorkflowSpec[]): string {
  if (specs.length === 0) {
    return "(no workflows registered)";
  }
  const rows = specs.map((s) => {
    const tags = s.tags && s.tags.length > 0 ? s.tags.join(",") : "(none)";
    const inputs = s.inputs ? Object.keys(s.inputs).join(",") : "(none)";
    const stepCount = countSteps(s.steps);
    return `| \`${s.name}\` | ${truncate(s.description, 60)} | ${stepCount} | ${inputs} | ${tags} |`;
  });
  return [
    "| name | description | steps | inputs | tags |",
    "|------|-------------|-------|--------|------|",
    ...rows,
  ].join("\n");
}

function countSteps(steps: unknown): number {
  if (!Array.isArray(steps)) return 0;
  let n = 0;
  for (const s of steps as WorkflowStep[]) {
    n += 1;
    const nested = (s as WorkflowStep).steps;
    if (Array.isArray(nested)) n += countSteps(nested);
  }
  return n;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

interface WorkflowStep {
  handler: string;
  steps?: unknown;
}

// ---------------------------------------------------------------------------
// WorkflowRegistry class
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private readonly byName: Map<string, WorkflowSpec>;
  public readonly errors: string[];
  public readonly packagedWorkflowsDir: string | null;
  public readonly projectWorkflowsDir: string | null;
  public readonly userWorkflowsDir: string | null;

  constructor(
    workflows: WorkflowSpec[],
    packagedWorkflowsDir: string | null,
    projectWorkflowsDir: string | null,
    userWorkflowsDir: string | null,
    errors: string[],
  ) {
    this.byName = new Map(workflows.map((s) => [s.name, s]));
    this.errors = errors;
    this.packagedWorkflowsDir = packagedWorkflowsDir;
    this.projectWorkflowsDir = projectWorkflowsDir;
    this.userWorkflowsDir = userWorkflowsDir;
  }

  static fromCwd(cwd: string, configDir = defaultConfigDir()): WorkflowRegistry {
    const result = discoverWorkflows(cwd, configDir);
    return new WorkflowRegistry(
      result.workflows,
      result.packagedWorkflowsDir,
      result.projectWorkflowsDir,
      result.userWorkflowsDir,
      result.errors,
    );
  }

  list(): WorkflowSpec[] {
    return Array.from(this.byName.values());
  }

  get(name: string): WorkflowSpec | null {
    return this.byName.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  formatForPrompt(): string {
    return formatRegistryForPrompt(this.list());
  }
}

// ---------------------------------------------------------------------------
// Save / persistence (used by `compose_workflow` with `save_as`)
// ---------------------------------------------------------------------------

/**
 * Persist a workflow to the project's `.pi/workflows/` directory.
 * Overwrites if the file exists. Returns the file path.
 */
export function saveWorkflowToProject(
  spec: WorkflowSpec,
  projectWorkflowsDir: string,
): string {
  fs.mkdirSync(projectWorkflowsDir, { recursive: true, mode: 0o700 });
  const filename = `${sanitizeName(spec.name)}.json`;
  const filePath = path.join(projectWorkflowsDir, filename);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return filePath;
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

// Keep this re-export for callers that need structural checks.
export { checkWorkflowStructural };
