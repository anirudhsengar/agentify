import * as fs from "node:fs";

const file = "src/core/audit/spawn-explorer-tool.ts";
const source = fs.readFileSync(file, "utf-8");
const staleBlock = `
        // Log external path access (Phase 2.6).
        if (params.allow_external_paths) {
            try {
                // Best-effort: log to the agentify log if available.
                // The actual write happens via ctx.log if exposed; we
                // emit a no-op here that the defense hook handler can pick
                // up. The audit trail is in the JSONL log via the
                // subagent_spawned event's details.
            } catch {
                // ignore
            }
        }
`;

if (!source.includes(staleBlock)) {
  throw new Error("stale allow_external_paths logging block was not found");
}

fs.writeFileSync(file, source.replace(staleBlock, ""));
console.log("stale explorer compatibility block removed");
