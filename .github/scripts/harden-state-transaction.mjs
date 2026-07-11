import * as fs from "node:fs";

function replaceOnce(file, label, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (!source.includes(before)) {
    throw new Error(`patch '${label}' did not match ${file}`);
  }
  fs.writeFileSync(file, source.replace(before, after));
}

replaceOnce(
  "src/core/state-transaction.ts",
  "committed phase type",
  `  phase: "prepared" | "backup_created" | "destination_ready";`,
  `  phase: "prepared" | "backup_created" | "destination_ready" | "committed";`,
);

replaceOnce(
  "src/core/state-transaction.ts",
  "committed phase validation",
  `    (value.phase !== "prepared" && value.phase !== "backup_created" && value.phase !== "destination_ready")`,
  `    (value.phase !== "prepared" &&\n      value.phase !== "backup_created" &&\n      value.phase !== "destination_ready" &&\n      value.phase !== "committed")`,
);

replaceOnce(
  "src/core/state-transaction.ts",
  "committed recovery",
  `  const backup = backupPath(cwd, journal.run_id);\n\n  if (fs.existsSync(backup)) {`,
  `  const backup = backupPath(cwd, journal.run_id);\n\n  if (journal.phase === "committed") {\n    // The durable commit marker is the commit point. Cleanup may have been\n    // interrupted, but the destination is authoritative and must survive.\n    fs.rmSync(backup, { recursive: true, force: true });\n    removeTransactionDirectory(cwd, journal.run_id);\n    return;\n  }\n\n  if (fs.existsSync(backup)) {`,
);

replaceOnce(
  "src/core/state-transaction.ts",
  "commit marker ordering",
  `      fs.rmSync(backup, { recursive: true, force: true });\n      removeTransactionDirectory(cwd, runId);\n      active = false;`,
  `      journal = { ...journal, phase: "committed" };\n      writeJsonAtomic(journalPath(cwd, runId), journal);\n      active = false;\n      try {\n        fs.rmSync(backup, { recursive: true, force: true });\n        removeTransactionDirectory(cwd, runId);\n      } catch {\n        // The committed journal is durable. Recovery will finish cleanup on\n        // the next run without rolling back the authoritative destination.\n      }`,
);

const runFile = "src/core/run-agentify.ts";
let runSource = fs.readFileSync(runFile, "utf-8");
const oldPrefix = `  const stateDir = stateDirResolved.relativeDir;
  const sourceStateDir = toRel(options.cwd, stateDirResolved.absoluteDir);
  const previousManifest = readManifestAt(options.cwd, sourceStateDir);
  const stateTransaction = beginStateTransaction({
    cwd: options.cwd,
    sourceRelativeDir: sourceStateDir,
    destinationRelativeDir: stateDir,
  });
  let commitState = false;
  if (stateDirResolved.legacy) {
    options.ui.info(
      \`agentify: detected legacy state at \${LEGACY_PI_STATE_RELATIVE_DIR}/; future runs will use \${stateDir}\`,
    );
  }
  // Pin the legacy \`write_map\` / \`write_map_delta\` tools to the
  // resolved state dir so canonical map writes land at
  // \`<stateDir>/codebase_map.json\` rather than the historical
  // \`.pi/agentify/\` location.
  setMapSessionStateDir(stateDir);
  // Pin the artifact renderer session the same way so feature
  // agents / prompts / workflows / skills / extensions land under
  // the resolved state dir rather than the legacy
  // \`.pi/agentify/...\` defaults.
  setRendererStateDir(stateDir);
  const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
  // Absolute paths of pre-existing user-owned artifacts the builder
  // must not overwrite mid-session (B4 / defense repo protection).
  const protectedPaths = [...artifactSnapshot.entries()]
    .filter(([, entry]) => entry.ownership === "unmanaged")
    .map(([rel]) => path.resolve(options.cwd, rel));
  const promptContent = loadBuilderPrompt(stateDir);
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: options.cwd, configDir: defaultConfigDir() });
  const start = Date.now();
  const sessionId = getOrCreateSessionId();
  setThinkingLevel(config.thinkingLevel ?? "high");

  log.runStart({
    cwd: options.cwd,
    args: options.args ?? "",
    model: config.model ?? "auto",
    thinking_level: config.thinkingLevel ?? "high",
    agentify_version: loadAgentifyVersion(),
    sdk_version: PI_SDK_VERSION,
    system_prompt_sha256: promptSha,
    system_prompt_path: "src/core/audit/prompts/builder.md",
    tool_allowlist: BUILDER_TOOL_ALLOWLIST,
  });

  options.ui.status("agentify: auditing existing codebase");
  setAgentifySessionActive(sessionId, true);
  try {
    const runtimeResult = await options.runtime.runSession({`;

const newPrefix = `  const stateDir = stateDirResolved.relativeDir;
  const sourceStateDir = toRel(options.cwd, stateDirResolved.absoluteDir);
  const previousManifest = readManifestAt(options.cwd, sourceStateDir);
  if (stateDirResolved.legacy) {
    options.ui.info(
      \`agentify: detected legacy state at \${LEGACY_PI_STATE_RELATIVE_DIR}/; future runs will use \${stateDir}\`,
    );
  }
  // Pin structured writers and deterministic renderers before moving state.
  // These setters are process-local and do not mutate the repository.
  setMapSessionStateDir(stateDir);
  setRendererStateDir(stateDir);
  const promptContent = loadBuilderPrompt(stateDir);
  const promptSha = crypto.createHash("sha256").update(promptContent).digest("hex");
  const log = new AgentifyLog({ cwd: options.cwd, configDir: defaultConfigDir() });
  const start = Date.now();
  const sessionId = getOrCreateSessionId();
  setThinkingLevel(config.thinkingLevel ?? "high");

  const stateTransaction = beginStateTransaction({
    cwd: options.cwd,
    sourceRelativeDir: sourceStateDir,
    destinationRelativeDir: stateDir,
  });
  let commitState = false;
  let artifactSnapshotForRollback: AuditArtifactSnapshot | null = null;
  try {
    const artifactSnapshot = collectAuditArtifactSnapshot(options.cwd);
    artifactSnapshotForRollback = artifactSnapshot;
    // Absolute paths of pre-existing user-owned artifacts the builder
    // must not overwrite mid-session (B4 / defense repo protection).
    const protectedPaths = [...artifactSnapshot.entries()]
      .filter(([, entry]) => entry.ownership === "unmanaged")
      .map(([rel]) => path.resolve(options.cwd, rel));

    log.runStart({
      cwd: options.cwd,
      args: options.args ?? "",
      model: config.model ?? "auto",
      thinking_level: config.thinkingLevel ?? "high",
      agentify_version: loadAgentifyVersion(),
      sdk_version: PI_SDK_VERSION,
      system_prompt_sha256: promptSha,
      system_prompt_path: "src/core/audit/prompts/builder.md",
      tool_allowlist: BUILDER_TOOL_ALLOWLIST,
    });

    options.ui.status("agentify: auditing existing codebase");
    setAgentifySessionActive(sessionId, true);
    const runtimeResult = await options.runtime.runSession({`;

if (!runSource.includes(oldPrefix)) {
  throw new Error("coordinator transaction boundary marker did not match");
}
runSource = runSource.replace(oldPrefix, newPrefix);

const oldCatch = `    rollbackGeneratedSurface(options.cwd, artifactSnapshot);`;
const newCatch = `    if (artifactSnapshotForRollback) {
      rollbackGeneratedSurface(options.cwd, artifactSnapshotForRollback);
    }`;
if (!runSource.includes(oldCatch)) throw new Error("coordinator catch rollback marker did not match");
runSource = runSource.replace(oldCatch, newCatch);
fs.writeFileSync(runFile, runSource);

console.log("state transaction crash boundaries hardened");
