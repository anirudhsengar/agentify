import {
  fileExists,
  makefileCommands,
  type BuildSystemDiscovery,
} from "./shared.ts";

export function discoverMakefileBuildSystem(cwd: string): BuildSystemDiscovery | null {
  if (!fileExists(cwd, "Makefile") && !fileExists(cwd, "makefile")) return null;
  const commands = makefileCommands(cwd);
  if (commands.length === 0) return null;
  return {
    manifest: { path: fileExists(cwd, "Makefile") ? "Makefile" : "makefile", ecosystem: "make" },
    commands,
    lockfile: null,
    requiresLockfile: false,
  };
}
