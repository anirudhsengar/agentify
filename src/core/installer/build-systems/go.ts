import {
  fileExists,
  makeCommand,
  makefileCommands,
  mergeValidationCommands,
  type BuildSystemDiscovery,
} from "./shared.ts";

export function discoverGoBuildSystem(cwd: string): BuildSystemDiscovery | null {
  if (!fileExists(cwd, "go.mod")) return null;
  const commands = mergeValidationCommands([
    makeCommand({
      kind: "test",
      label: "go-test",
      argv: ["go", "test", "./..."],
      detail: "Go test discovered",
    }),
    makeCommand({
      kind: "typecheck",
      label: "go-vet",
      argv: ["go", "vet", "./..."],
      detail: "Go vet discovered",
    }),
    ...makefileCommands(cwd),
  ]);
  return {
    manifest: { path: "go.mod", ecosystem: "go" },
    commands,
    lockfile: fileExists(cwd, "go.sum") ? { path: "go.sum" } : null,
    requiresLockfile: true,
  };
}
