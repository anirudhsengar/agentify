// paths.ts — centralized filesystem layout for the orchestrator subsystem.
//
// All orchestrator state lives under <configDir>/orchestrator/.
// Sub-agent state lives under agents/<agent_id>/. The layout mirrors
// the AIW layout for consistency:
//
//   <configDir>/
//   └── orchestrator/
//       ├── orchestrator.pid            # daemon pidfile (CLI mode)
//       ├── orchestrator.session.json   # the orchestrator's own session id
//       ├── events.jsonl                # orchestrator-level event log
//       ├── execution.log               # human-readable orchestrator log
//       ├── cost.json                   # cost accumulator (orchestrator + fleet)
//       └── agents/
//           ├── <agent_id>/
//           │   ├── state.json          # latest AgentState (atomic write)
//           │   ├── events.jsonl        # append-only event log
//           │   ├── execution.log       # human-readable log
//           │   └── prompts/
//           │       └── <ts>.txt        # exact prompt sent to the sub-agent
//           └── _archive/
//               └── <agent_id>-<ts>/    # delete_agent --archive target
//
// The agents directory is **gitignored** (runtime noise) when the
// orchestrator is hosted inside a git repo (handled in the test
// scaffolding; not the orchestrator's concern).

import * as path from "node:path";
import * as fs from "node:fs";

export interface OrchestratorPaths {
  orchestratorRoot: string;
  agentsRoot: string;
  archiveRoot: string;
  pidFile: string;
  sessionFile: string;
  eventsFile: string;
  executionLog: string;
  costFile: string;
  /** orchestrator workflows: per-workflow-run subdirectories live here. */
  workflowsRoot: string;
  /** orchestrator workflows: pending sub-agent → orchestrator escalations. */
  escalationsRoot: string;
}

export interface AgentPaths {
  agentRoot: string;
  stateFile: string;
  eventsFile: string;
  executionLog: string;
  promptsDir: string;
}

export function orchestratorPaths(configDir: string): OrchestratorPaths {
  const orchestratorRoot = path.join(configDir, "orchestrator");
  const agentsRoot = path.join(orchestratorRoot, "agents");
  const archiveRoot = path.join(agentsRoot, "_archive");
  return {
    orchestratorRoot,
    agentsRoot,
    archiveRoot,
    pidFile: path.join(orchestratorRoot, "orchestrator.pid"),
    sessionFile: path.join(orchestratorRoot, "orchestrator.session.json"),
    eventsFile: path.join(orchestratorRoot, "events.jsonl"),
    executionLog: path.join(orchestratorRoot, "execution.log"),
    costFile: path.join(orchestratorRoot, "cost.json"),
    workflowsRoot: path.join(orchestratorRoot, "workflows"),
    escalationsRoot: path.join(orchestratorRoot, "escalations"),
  };
}

export function agentPaths(configDir: string, agentId: string): AgentPaths {
  const agentRoot = path.join(orchestratorPaths(configDir).agentsRoot, agentId);
  return {
    agentRoot,
    stateFile: path.join(agentRoot, "state.json"),
    eventsFile: path.join(agentRoot, "events.jsonl"),
    executionLog: path.join(agentRoot, "execution.log"),
    promptsDir: path.join(agentRoot, "prompts"),
  };
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

export function ensureOrchestratorDirs(paths: OrchestratorPaths): void {
  fs.mkdirSync(paths.orchestratorRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.agentsRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.archiveRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.workflowsRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.escalationsRoot, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.eventsFile)) {
    fs.writeFileSync(paths.eventsFile, "", { mode: 0o600 });
  }
  if (!fs.existsSync(paths.costFile)) {
    fs.writeFileSync(paths.costFile, JSON.stringify({ orchestrator_cost_usd: 0, total_cost_usd: 0 }, null, 2), { mode: 0o600 });
  }
}

export function ensureAgentDirs(paths: AgentPaths): void {
  fs.mkdirSync(paths.agentRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.promptsDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.eventsFile)) {
    fs.writeFileSync(paths.eventsFile, "", { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// IO: state.json (atomic write)
// ---------------------------------------------------------------------------

export function writeAgentState(paths: AgentPaths, state: import("./state.ts").AgentState): void {
  ensureAgentDirs(paths);
  const finalPath = paths.stateFile;
  const tmp = `${finalPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, finalPath);
}

export function readAgentState(paths: AgentPaths): import("./state.ts").AgentState | null {
  if (!fs.existsSync(paths.stateFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.stateFile, "utf-8")) as unknown;
    return raw as import("./state.ts").AgentState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// IO: events.jsonl (append-only)
// ---------------------------------------------------------------------------

export function appendAgentEvent(
  paths: AgentPaths,
  event: {
    kind: string;
    fields?: Record<string, unknown>;
  },
): void {
  ensureAgentDirs(paths);
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

export function readAgentEvents(paths: AgentPaths): Array<{
  at: string;
  kind: string;
  fields?: Record<string, unknown>;
}> {
  if (!fs.existsSync(paths.eventsFile)) return [];
  const raw = fs.readFileSync(paths.eventsFile, "utf-8");
  const out: Array<{ at: string; kind: string; fields?: Record<string, unknown> }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as { at: string; kind: string; fields?: Record<string, unknown> });
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO: prompts/<ts>.txt
// ---------------------------------------------------------------------------

export function writeAgentPrompt(
  paths: AgentPaths,
  prompt: string,
  timestamp?: string,
): string {
  ensureAgentDirs(paths);
  const ts = (timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const file = path.join(paths.promptsDir, `${ts}.txt`);
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// IO: execution.log
// ---------------------------------------------------------------------------

export function appendAgentExecutionLog(paths: AgentPaths, message: string): void {
  ensureAgentDirs(paths);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(paths.executionLog, line, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Orchestrator-level IO
// ---------------------------------------------------------------------------

export function appendOrchestratorEvent(
  paths: OrchestratorPaths,
  event: { kind: string; fields?: Record<string, unknown> },
): void {
  ensureOrchestratorDirs(paths);
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  const fd = fs.openSync(paths.eventsFile, "a");
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

export function appendOrchestratorExecutionLog(paths: OrchestratorPaths, message: string): void {
  ensureOrchestratorDirs(paths);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(paths.executionLog, line, { mode: 0o600 });
}

export interface OrchestratorSessionRecord {
  session_id: string;
  started_at: string;
  cwd: string;
}

export function writeOrchestratorSession(paths: OrchestratorPaths, record: OrchestratorSessionRecord): void {
  ensureOrchestratorDirs(paths);
  const tmp = `${paths.sessionFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, paths.sessionFile);
}

export function readOrchestratorSession(paths: OrchestratorPaths): OrchestratorSessionRecord | null {
  if (!fs.existsSync(paths.sessionFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.sessionFile, "utf-8")) as OrchestratorSessionRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cost accumulator
// ---------------------------------------------------------------------------

export interface CostRecord {
  orchestrator_cost_usd: number;
  total_cost_usd: number;
  /** Per-agent_id contributions; updated on every message_end. */
  per_agent: Record<string, number>;
  /** Per-aiw_id contributions; updated when AIWs are checked. */
  per_aiw: Record<string, number>;
}

export function readCostRecord(paths: OrchestratorPaths): CostRecord {
  ensureOrchestratorDirs(paths);
  if (!fs.existsSync(paths.costFile)) {
    return { orchestrator_cost_usd: 0, total_cost_usd: 0, per_agent: {}, per_aiw: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(paths.costFile, "utf-8")) as CostRecord;
  } catch {
    return { orchestrator_cost_usd: 0, total_cost_usd: 0, per_agent: {}, per_aiw: {} };
  }
}

export function writeCostRecord(paths: OrchestratorPaths, record: CostRecord): void {
  ensureOrchestratorDirs(paths);
  const tmp = `${paths.costFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, paths.costFile);
}

// ---------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------

export function listAgentDirs(configDir: string): string[] {
  const root = orchestratorPaths(configDir).agentsRoot;
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_archive") continue;
    out.push(entry.name);
  }
  return out.sort();
}

export function readAllAgentStates(configDir: string): import("./state.ts").AgentState[] {
  const ids = listAgentDirs(configDir);
  const states: import("./state.ts").AgentState[] = [];
  for (const id of ids) {
    const s = readAgentState(agentPaths(configDir, id));
    if (s) states.push(s);
  }
  return states;
}

// ---------------------------------------------------------------------------
// orchestrator workflows: Workflow run paths + Escalation ticket paths
// ---------------------------------------------------------------------------

export interface WorkflowRunPaths {
  workflowRunRoot: string;
  stateFile: string;
  specFile: string;
  eventsFile: string;
  executionLog: string;
  summaryFile: string;
}

export interface EscalationPaths {
  escalationsRoot: string;
  ticketFile: string;
}

export function workflowRunPaths(configDir: string, workflowRunId: string): WorkflowRunPaths {
  const workflowsRoot = orchestratorPaths(configDir).workflowsRoot;
  const workflowRunRoot = path.join(workflowsRoot, workflowRunId);
  return {
    workflowRunRoot,
    stateFile: path.join(workflowRunRoot, "workflow_run.json"),
    specFile: path.join(workflowRunRoot, "workflow_spec.json"),
    eventsFile: path.join(workflowRunRoot, "events.jsonl"),
    executionLog: path.join(workflowRunRoot, "execution.log"),
    summaryFile: path.join(workflowRunRoot, "summary.jsonl"),
  };
}

export function ensureWorkflowRunDirs(paths: WorkflowRunPaths): void {
  fs.mkdirSync(paths.workflowRunRoot, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(paths.eventsFile)) {
    fs.writeFileSync(paths.eventsFile, "", { mode: 0o600 });
  }
  if (!fs.existsSync(paths.summaryFile)) {
    fs.writeFileSync(paths.summaryFile, "", { mode: 0o600 });
  }
}

export function writeWorkflowRunState(
  paths: WorkflowRunPaths,
  state: import("./workflow-spec.ts").WorkflowRunState,
): void {
  ensureWorkflowRunDirs(paths);
  const tmp = `${paths.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, paths.stateFile);
}

export function readWorkflowRunState(
  paths: WorkflowRunPaths,
): import("./workflow-spec.ts").WorkflowRunState | null {
  if (!fs.existsSync(paths.stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.stateFile, "utf-8")) as import("./workflow-spec.ts").WorkflowRunState;
  } catch {
    return null;
  }
}

export function appendWorkflowRunEvent(
  paths: WorkflowRunPaths,
  event: { kind: string; fields?: Record<string, unknown> },
): void {
  ensureWorkflowRunDirs(paths);
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  fs.appendFileSync(paths.eventsFile, line, { mode: 0o600 });
}

export function readWorkflowRunEvents(
  paths: WorkflowRunPaths,
): Array<{ at: string; kind: string; fields?: Record<string, unknown> }> {
  if (!fs.existsSync(paths.eventsFile)) return [];
  const raw = fs.readFileSync(paths.eventsFile, "utf-8");
  const out: Array<{ at: string; kind: string; fields?: Record<string, unknown> }> = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as { at: string; kind: string; fields?: Record<string, unknown> });
    } catch {
      // skip
    }
  }
  return out;
}

export function appendWorkflowRunExecutionLog(
  paths: WorkflowRunPaths,
  message: string,
): void {
  ensureWorkflowRunDirs(paths);
  fs.appendFileSync(paths.executionLog, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

export function listWorkflowRunDirs(configDir: string): string[] {
  const root = orchestratorPaths(configDir).workflowsRoot;
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    out.push(entry.name);
  }
  return out.sort();
}

export function readAllWorkflowRunStates(
  configDir: string,
): import("./workflow-spec.ts").WorkflowRunState[] {
  const ids = listWorkflowRunDirs(configDir);
  const out: import("./workflow-spec.ts").WorkflowRunState[] = [];
  for (const id of ids) {
    const s = readWorkflowRunState(workflowRunPaths(configDir, id));
    if (s) out.push(s);
  }
  return out;
}

// Escalation IO
export interface EscalationTicketRecord {
  ticket_id: string;
  agent_id: string;
  agent_name: string;
  reason: string;
  question: string;
  options: string[];
  blocking: boolean;
  created_at: string;
  resolved_at: string | null;
  orchestrator_reply: string | null;
}

export function escalationPaths(configDir: string, ticketId: string): EscalationPaths {
  const root = orchestratorPaths(configDir).escalationsRoot;
  return {
    escalationsRoot: root,
    ticketFile: path.join(root, `${ticketId}.json`),
  };
}

export function writeEscalationTicket(
  paths: EscalationPaths,
  ticket: EscalationTicketRecord,
): void {
  fs.mkdirSync(paths.escalationsRoot, { recursive: true, mode: 0o700 });
  const tmp = `${paths.ticketFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ticket, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, paths.ticketFile);
}

export function readEscalationTicket(
  paths: EscalationPaths,
): EscalationTicketRecord | null {
  if (!fs.existsSync(paths.ticketFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.ticketFile, "utf-8")) as EscalationTicketRecord;
  } catch {
    return null;
  }
}

export function listOpenEscalations(configDir: string): EscalationTicketRecord[] {
  const root = orchestratorPaths(configDir).escalationsRoot;
  if (!fs.existsSync(root)) return [];
  const out: EscalationTicketRecord[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) continue;
    const p = path.join(root, entry.name);
    try {
      const t = JSON.parse(fs.readFileSync(p, "utf-8")) as EscalationTicketRecord;
      if (!t.resolved_at) out.push(t);
    } catch {
      // skip
    }
  }
  return out;
}
