import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFeatureAgentFilename } from "../artifacts/agent-file-conventions.ts";
import { addMarkdownManagedMarker } from "../artifacts/managed-markers.ts";

export function captureSessionAgentFiles(cwd: string, stateDir = ".pi"): string {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentify-session-agents-"));
  const sourceAgentsDir = path.join(cwd, stateDir, "agents");
  if (!fs.existsSync(sourceAgentsDir)) return snapshotDir;
  const targetAgentsDir = path.join(snapshotDir, "agents");
  fs.mkdirSync(targetAgentsDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceAgentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    fs.copyFileSync(
      path.join(sourceAgentsDir, entry.name),
      path.join(targetAgentsDir, entry.name),
    );
  }
  return snapshotDir;
}

export function mirrorSessionOutputToStaging(
  snapshotDir: string,
  stagingRoot: string,
  stateDir = ".pi",
): void {
  const agentsDir = path.join(snapshotDir, "agents");
  if (!fs.existsSync(agentsDir)) return;
  const targetAgentsDir = path.join(stagingRoot, stateDir, "agents");
  fs.mkdirSync(targetAgentsDir, { recursive: true });
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isFeatureAgentFilename(entry.name)) continue;
    const raw = fs.readFileSync(path.join(agentsDir, entry.name), "utf-8");
    fs.writeFileSync(
      path.join(targetAgentsDir, entry.name),
      addMarkdownManagedMarker(raw),
      { mode: 0o644 },
    );
  }
}

export function cleanupSessionAgentSnapshot(snapshotDir: string): void {
  try {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup; a leaked temp dir is harmless.
  }
}
