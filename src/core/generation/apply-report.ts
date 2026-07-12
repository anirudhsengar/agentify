import * as path from "node:path";
import { alongsidePathFor } from "../apply-policy.ts";
import { normalizeArtifactPath } from "../artifacts/generated-surface.ts";
import type { ArtifactWrite } from "../types.ts";

function toRel(cwd: string, filePath: string): string {
  return normalizeArtifactPath(path.relative(cwd, filePath));
}

export function formatApplyReport(
  writes: readonly ArtifactWrite[],
  cwd: string,
): string[] {
  const written = writes.filter((w) => w.action === "written");
  const kept = writes.filter((w) => w.action === "skipped");
  const alongside = writes.filter((w) => w.action === "alongside");
  const conflicts = writes.filter((w) => w.action === "conflict");

  const lines: string[] = [];
  const conflictSuffix = conflicts.length > 0
    ? `, ${conflicts.length} conflict(s)`
    : "";
  lines.push(
    `agentify: apply report: ` +
    `${written.length} created, ` +
    `${kept.length} kept-user, ` +
    `${alongside.length} saved-alongside` +
    conflictSuffix +
    ".",
  );

  if (alongside.length > 0) {
    lines.push(
      "agentify: agentify's versions saved alongside (suffix .agentify.<ext>):",
    );
    for (const w of alongside.slice(0, 16)) {
      const rel = toRel(cwd, w.path);
      const alongsideRel = w.alongsidePath ?? alongsidePathFor(rel);
      lines.push(`agentify:   - ${rel} -> ${alongsideRel}`);
    }
    if (alongside.length > 16) {
      lines.push(`agentify:   ... and ${alongside.length - 16} more`);
    }
  }

  if (conflicts.length > 0) {
    lines.push(
      "agentify: conflicts (not written; requiredAction=abort in rc file):",
    );
    for (const w of conflicts.slice(0, 8)) {
      lines.push(
        `agentify:   - ${toRel(cwd, w.path)}: ${w.reason ?? "conflict"}`,
      );
    }
  }

  return lines;
}
