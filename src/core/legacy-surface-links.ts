import * as fs from "node:fs";
import * as path from "node:path";

const LEGACY_SURFACE_ENTRIES = [
  "agents",
  "prompts",
  "workflows",
  "extensions",
  "conditional_docs.md",
] as const;

export interface LegacySurfaceLinkResult {
  created: string[];
  retained: string[];
}

/**
 * The generated Agentify surface is owned by the selected harness's state
 * directory. Pi-shaped paths remain as relative links so existing prompts,
 * skills, and generated GitHub runtime files continue to resolve without
 * making `.pi` the second physical home for the same data.
 */
export function linkLegacyPiSurface(cwd: string, stateDir: string): LegacySurfaceLinkResult {
  const created: string[] = [];
  const retained: string[] = [];
  const piRoot = path.join(cwd, ".pi");
  const piRootStat = fs.lstatSync(piRoot, { throwIfNoEntry: false });
  if (piRootStat?.isSymbolicLink() || (piRootStat && !piRootStat.isDirectory())) {
    return {
      created,
      retained: LEGACY_SURFACE_ENTRIES.map((entry) => `.pi/${entry}`),
    };
  }
  for (const entry of LEGACY_SURFACE_ENTRIES) {
    const linkPath = path.join(cwd, ".pi", entry);
    const targetPath = path.join(cwd, stateDir, entry);
    const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    const target = path.relative(path.dirname(linkPath), targetPath) || ".";
    if (existing?.isSymbolicLink()) {
      if (fs.readlinkSync(linkPath) === target) continue;
      retained.push(`.pi/${entry}`);
      continue;
    }
    if (existing) {
      retained.push(`.pi/${entry}`);
      continue;
    }
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, entry === "conditional_docs.md" ? "file" : "dir");
    created.push(`.pi/${entry}`);
  }
  return { created, retained };
}
