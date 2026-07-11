import * as fs from "node:fs";

const file = "src/core/run-agentify.ts";
let source = fs.readFileSync(file, "utf-8");

function replaceOnce(label, before, after) {
  if (!source.includes(before)) throw new Error(`state transaction patch '${label}' did not match`);
  source = source.replace(before, after);
}

replaceOnce(
  "transaction import",
  `import { createReadOnlyExecutionPolicy } from "./security/execution-policy.ts";`,
  `import { createReadOnlyExecutionPolicy } from "./security/execution-policy.ts";\nimport { beginStateTransaction } from "./state-transaction.ts";`,
);

replaceOnce(
  "final state signature",
  `function readFinalAuditState(cwd: string): FinalAuditState {`,
  `function readFinalAuditState(cwd: string, stateDir: string): FinalAuditState {`,
);
replaceOnce(
  "final state map path",
  `  const map = loadCanonicalMapAt(cwd, LEGACY_PI_STATE_RELATIVE_DIR);`,
  `  const map = loadCanonicalMapAt(cwd, stateDir);`,
);
replaceOnce(
  "final state missing map message",
  `      \`no valid codebase map at \${LEGACY_PI_STATE_RELATIVE_DIR}/codebase_map.json (write_map was never completed or failed schema validation)\`,`,
  `      \`no valid codebase map at \${stateDir}/codebase_map.json (write_map was never completed or failed schema validation)\`,`,
);

replaceOnce(
  "transaction begin",
  `  const stateDir = stateDirResolved.relativeDir;\n  if (stateDirResolved.legacy) {`,
  `  const stateDir = stateDirResolved.relativeDir;\n  const sourceStateDir = toRel(options.cwd, stateDirResolved.absoluteDir);\n  const previousManifest = readManifestAt(options.cwd, sourceStateDir);\n  const stateTransaction = beginStateTransaction({\n    cwd: options.cwd,\n    sourceRelativeDir: sourceStateDir,\n    destinationRelativeDir: stateDir,\n  });\n  let commitState = false;\n  if (stateDirResolved.legacy) {`,
);
replaceOnce(
  "remove destructive cleanup",
  `  const internalStateSnapshot = collectInternalStateSnapshot(options.cwd);\n  cleanupInternalScaffoldingAt(options.cwd, stateDir);\n`,
  ``,
);
replaceOnce(
  "final state call",
  `      : readFinalAuditState(options.cwd);`,
  `      : readFinalAuditState(options.cwd, stateDir);`,
);

const restoreCall = `restoreInternalStateSnapshotAt(options.cwd, internalStateSnapshot, stateDir);`;
if (!source.includes(restoreCall)) throw new Error("state rollback calls were not found");
source = source.replaceAll(restoreCall, `stateTransaction.rollback();`);

replaceOnce(
  "remove late manifest read",
  `          const previousManifest = readManifestAt(options.cwd, stateDir);\n`,
  ``,
);

replaceOnce(
  "mark state commit",
  `              featureAgentCount: repoState.featureAgentCount,\n              latestLogPath: log.logPath,\n            });\n          }`,
  `              featureAgentCount: repoState.featureAgentCount,\n              latestLogPath: log.logPath,\n            });\n            commitState = true;\n          }`,
);

replaceOnce(
  "finish state transaction",
  `    options.ui.info(\`agentify: log written to \${log.logPath}\`);\n  } catch (err) {`,
  `    options.ui.info(\`agentify: log written to \${log.logPath}\`);\n    if (commitState) stateTransaction.commit();\n    else stateTransaction.rollback();\n  } catch (err) {`,
);

fs.writeFileSync(file, source);
console.log("run-agentify state transaction integration applied");
