// paths.ts — centralized filesystem layout for the AIW subsystem.
//
// All AIW state lives under <configDir>/aiw/<aiw_id>/. The webhook
// queue lives under <configDir>/queue/; we keep AIW state separate so
// each subsystem can be reasoned about independently.
//
// Layout:
//
//   <configDir>/
//   ├── aiw/
//   │   ├── <aiw_id>/
//   │   │   ├── state.json        # latest AiwState (atomic write)
//   │   │   ├── events.jsonl      # append-only event log
//   │   │   ├── execution.log     # human-readable log
//   │   │   ├── prompts/
//   │   │   │   └── <phase>-<ts>.txt  # exact prompt sent to each phase
//   │   │   └── agents/
//   │   │       └── <phase>/      # per-phase runtime output (gitignored)
//   │   └── kpis.md               # agentic_kpis.md (see kpis.ts)
//   └── ...                       # other subsystems (queue/, tasks/)
//
// Trees and agents dirs in the *project* live outside this configDir:
//   <project>/trees/<aiw_id>/     # git worktree (managed by isolation.ts)
//   <project>/agents/<aiw_id>/    # runtime output (gitignored)

import * as path from "node:path";
import * as fs from "node:fs";

export interface AiwPaths {
  aiwRoot: string;
  stateFile: string;
  eventsFile: string;
  executionLog: string;
  promptsDir: string;
  agentsDir: string;
  kpisFile: string;
}

export function aiwPaths(configDir: string): AiwPaths {
  const aiwRoot = path.join(configDir, "aiw");
  return {
    aiwRoot,
    stateFile: path.join(aiwRoot, "state.json"),
    eventsFile: path.join(aiwRoot, "events.jsonl"),
    executionLog: path.join(aiwRoot, "execution.log"),
    promptsDir: path.join(aiwRoot, "prompts"),
    agentsDir: path.join(aiwRoot, "agents"),
    kpisFile: path.join(aiwRoot, "kpis.md"),
  };
}

export function aiwStatePaths(configDir: string, aiwId: string): AiwPaths {
  const root = path.join(configDir, "aiw", aiwId);
  return {
    aiwRoot: root,
    stateFile: path.join(root, "state.json"),
    eventsFile: path.join(root, "events.jsonl"),
    executionLog: path.join(root, "execution.log"),
    promptsDir: path.join(root, "prompts"),
    agentsDir: path.join(root, "agents"),
    // KPIs file is shared across all AIWs; lives at the parent.
    kpisFile: path.join(configDir, "aiw", "kpis.md"),
  };
}

export function ensureAiwDirs(paths: AiwPaths): void {
  fs.mkdirSync(paths.aiwRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.promptsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.eventsFile)) {
    fs.writeFileSync(paths.eventsFile, "", { mode: 0o600 });
  }
}

export function ensureAiwStateDirs(paths: AiwPaths): void {
  fs.mkdirSync(paths.aiwRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.promptsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.agentsDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.eventsFile)) {
    fs.writeFileSync(paths.eventsFile, "", { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// IO: state.json (atomic)
// ---------------------------------------------------------------------------

export function writeAiwState(paths: AiwPaths, state: import("./state.ts").AiwState): void {
  ensureAiwStateDirs(paths);
  const finalPath = paths.stateFile;
  const tmp = `${finalPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
}

export function readAiwState(paths: AiwPaths): import("./state.ts").AiwState | null {
  if (!fs.existsSync(paths.stateFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.stateFile, "utf-8")) as Record<string, unknown>;
    if (raw.changeType === undefined) {
      if (typeof raw.change_type === "string") {
        raw.changeType = raw.change_type;
      } else if (typeof raw.classification === "string") {
        raw.changeType = raw.classification;
      }
    }
    return raw as import("./state.ts").AiwState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IO: events.jsonl (append-only)
// ---------------------------------------------------------------------------

export function appendAiwEvent(
  paths: AiwPaths,
  event: {
    kind: string;
    phase?: string;
    fields?: Record<string, unknown>;
  },
): void {
  ensureAiwStateDirs(paths);
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  }) + "\n";
  const fd = fs.openSync(paths.eventsFile, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

export function readAiwEvents(paths: AiwPaths): Array<{
  at: string;
  kind: string;
  phase?: string;
  fields?: Record<string, unknown>;
}> {
  if (!fs.existsSync(paths.eventsFile)) return [];
  const raw = fs.readFileSync(paths.eventsFile, "utf-8");
  const out: ReturnType<typeof JSON.parse>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ReturnType<typeof JSON.parse>);
    } catch {
      // Skip malformed lines.
    }
  }
  return out as Array<{
    at: string;
    kind: string;
    phase?: string;
    fields?: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// IO: prompts/<phase>-<ts>.txt (audit receipt)
// ---------------------------------------------------------------------------

export function writePhasePrompt(
  paths: AiwPaths,
  phase: string,
  prompt: string,
  timestamp?: string,
): void {
  ensureAiwStateDirs(paths);
  const ts = (timestamp ?? new Date().toISOString())
    .replace(/[:.]/g, "-");
  const file = path.join(paths.promptsDir, `${phase}-${ts}.txt`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// IO: execution.log (human-readable)
// ---------------------------------------------------------------------------

export function appendExecutionLog(paths: AiwPaths, message: string): void {
  ensureAiwStateDirs(paths);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(paths.executionLog, line, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Per-phase runtime directory (Pi session output)
// ---------------------------------------------------------------------------

export function phaseAgentDir(paths: AiwPaths, phase: string): string {
  const dir = path.join(paths.agentsDir, phase);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}