import {
  fileExists,
  makeCommand,
  makefileCommands,
  mergeValidationCommands,
  type BuildSystemDiscovery,
} from "./shared.ts";

export function discoverRubyBuildSystem(cwd: string): BuildSystemDiscovery | null {
  if (!fileExists(cwd, "Gemfile")) return null;
  const commands = mergeValidationCommands([
    makeCommand({
      kind: "install",
      label: "bundle-install",
      argv: ["bundle", "install"],
      required: false,
      detail: "Ruby bundle install discovered",
    }),
    makeCommand({
      kind: "test",
      label: "rspec",
      argv: ["bundle", "exec", "rspec"],
      detail: "Ruby rspec test discovered",
    }),
    makeCommand({
      kind: "lint",
      label: "rubocop",
      argv: ["bundle", "exec", "rubocop"],
      required: false,
      detail: "Ruby rubocop lint discovered",
    }),
    ...makefileCommands(cwd),
  ]);
  return {
    manifest: { path: "Gemfile", ecosystem: "ruby" },
    commands,
    lockfile: fileExists(cwd, "Gemfile.lock") ? { path: "Gemfile.lock" } : null,
    requiresLockfile: true,
  };
}
