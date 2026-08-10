import {
  fileExists,
  makeCommand,
  makefileCommands,
  mergeValidationCommands,
  type BuildSystemDiscovery,
} from "./shared.ts";

export function discoverRustBuildSystem(cwd: string): BuildSystemDiscovery | null {
  if (!fileExists(cwd, "Cargo.toml")) return null;
  const commands = mergeValidationCommands([
    makeCommand({
      kind: "install",
      label: "fetch",
      argv: ["cargo", "fetch", "--locked"],
      required: false,
      detail: "deterministic Rust dependency fetch discovered",
    }),
    makeCommand({
      kind: "test",
      label: "cargo-test",
      argv: ["cargo", "test", "--locked"],
      detail: "Rust cargo test discovered",
    }),
    makeCommand({
      kind: "typecheck",
      label: "cargo-check",
      argv: ["cargo", "check", "--locked"],
      detail: "Rust cargo check discovered",
    }),
    makeCommand({
      kind: "lint",
      label: "cargo-clippy",
      argv: ["cargo", "clippy", "--locked", "--", "-D", "warnings"],
      required: false,
      detail: "Rust cargo clippy discovered",
    }),
    ...makefileCommands(cwd),
  ]);
  return {
    manifest: { path: "Cargo.toml", ecosystem: "rust" },
    commands,
    lockfile: fileExists(cwd, "Cargo.lock") ? { path: "Cargo.lock" } : null,
    requiresLockfile: true,
  };
}
