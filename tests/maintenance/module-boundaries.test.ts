import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

function staticStringArray(source: string, declarationName: string): string[] {
  const declaration = source.match(new RegExp(`${declarationName}\\s*=\\s*\\[([^\\]]+)\\]`, "s"));
  assert.ok(declaration, `${declarationName} must remain statically inspectable`);
  return [...declaration[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

test("public command inventory is exact", () => {
  const expected = ["login", "logout", "models"];
  assert.deepEqual(staticStringArray(read("src/core/public-cli-contract.ts"), "PUBLIC_SUBCOMMAND_NAMES"), expected);
  assert.deepEqual(staticStringArray(read("src/core/cli-commands.ts"), "SUBCOMMAND_NAMES"), expected);
  const help = read("tests/parity/fixtures/cli-help.txt");
  for (const command of expected) assert.match(help, new RegExp(`^  agentify ${command}\\b`, "m"));
  const documented = new Set((help.match(/^  agentify \w+/gm) ?? []).map((line) => line.trim().split(" ")[1]));
  assert.deepEqual([...documented], expected);
});

test("package and build expose only focused compiled roots", () => {
  const packageJson = JSON.parse(read("package.json")) as { exports?: unknown; files?: string[] };
  assert.deepEqual(packageJson.exports, { "./package.json": "./package.json" });
  assert.ok(!(packageJson.files ?? []).includes("src"));
  const build = read("scripts/build.mjs");
  assert.match(build, /source:\s*path\.join\(repoRoot, "src", "cli\.ts"\)/);
  assert.match(build, /source:\s*path\.join\(repoRoot, "src", "core", "learning", "cli\.ts"\)/);
  assert.match(build, /source:\s*path\.join\(repoRoot, "src", "core", "task-lifecycle", "cli\.ts"\)/);
  assert.doesNotMatch(build, /"aiw"|"webhook"|"orchestrator"/);
});

test("public documentation contains no package-internal import examples", () => {
  const documentation = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    ...fs.readdirSync(path.join(ROOT, "docs"), { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".md"))
      .map((entry) => path.join("docs", entry)),
  ];
  const internalImport = /(?:from\s+|import\s*\(|require\s*\()\s*["'`]agentify\/(?:src|dist|core)\//;
  for (const relativePath of documentation) assert.doesNotMatch(read(relativePath), internalImport, relativePath);
});
