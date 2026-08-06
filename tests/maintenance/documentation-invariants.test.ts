import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

interface PackageJson {
  name: string;
  version: string;
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  exports?: Record<string, string>;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

function packageJson(): PackageJson {
  return JSON.parse(read("package.json")) as PackageJson;
}

function markdownFiles(): string[] {
  return [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    ...fs.readdirSync(path.join(ROOT, "docs"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")),
  ].sort();
}

test("repository release metadata is internally consistent", () => {
  const manifest = packageJson();
  const lock = JSON.parse(read("package-lock.json")) as {
    name?: string;
    version?: string;
    packages?: Record<string, { name?: string; version?: string }>;
  };
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages?.[""]?.version, manifest.version);
  assert.match(read("CHANGELOG.md"), /^## \[Unreleased\]$/m);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("strict TypeScript and unused-code checks are enabled", () => {
  const config = JSON.parse(read("tsconfig.json")) as {
    compilerOptions?: { strict?: boolean; noUnusedLocals?: boolean; noUnusedParameters?: boolean };
  };
  assert.equal(config.compilerOptions?.strict, true);
  assert.equal(config.compilerOptions?.noUnusedLocals, true);
  assert.equal(config.compilerOptions?.noUnusedParameters, true);
});

test("documentation has one indexed current tree and no broken relative links", () => {
  const documents = markdownFiles();
  assert.ok(documents.includes("docs/README.md"));
  const linkPattern = /\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/g;
  for (const relativePath of documents) {
    const source = read(relativePath);
    for (const match of source.matchAll(linkPattern)) {
      const target = path.resolve(ROOT, path.dirname(relativePath), decodeURIComponent(match[1]!));
      assert.ok(fs.existsSync(target), `${relativePath} has a broken link to ${match[1]}`);
    }
  }
  const index = read("docs/README.md");
  for (const document of documents.filter((file) => file.startsWith("docs/") && file !== "docs/README.md")) {
    const relative = path.relative(path.join(ROOT, "docs"), path.join(ROOT, document)).split(path.sep).join("/");
    assert.ok(index.includes(relative), `docs/README.md must index ${document}`);
  }
});

test("current source and normative docs contain no obsolete project terminology", () => {
  const sourceFiles = fs.readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  const files = [...sourceFiles, ...markdownFiles().map((file) => path.join(ROOT, file))];
  const forbidden = [
    new RegExp(["green", "field"].join(""), "i"),
    /\.pi\/agentify/i,
    /\.agents\/agentify/i,
    /\.claude\/agentify/i,
    /AGENTIFY_OLD_UI/,
    /selected_targets/,
    /harness_export/,
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, path.relative(ROOT, file));
  }
});

test("package surface and release hierarchy are explicit", () => {
  const manifest = packageJson();
  const files = new Set(manifest.files ?? []);
  assert.equal(manifest.name, "@anirudhsengar/agentify");
  assert.deepEqual(manifest.bin, { agentify: "./bin/agentify.js" });
  assert.deepEqual(manifest.exports, { "./package.json": "./package.json" });
  assert.equal(files.has("src"), false);
  for (const document of markdownFiles()) assert.ok(files.has(document), `package must include ${document}`);
  for (const runtime of ["bin", "dist", "scaffold/.github/workflows/agentify-issue.yml", "scaffold/.github/workflows/agentify-learn.yml"]) {
    assert.ok(files.has(runtime), `package must include ${runtime}`);
  }
  const scripts = manifest.scripts ?? {};
  assert.equal(scripts["test:package"], "node tests/package/exact-artifact-qualification.mjs");
  assert.equal(scripts["test:parity"], "npm run build && npm run test:parity:cli");
  assert.equal(scripts["verify:release"], "npm run verify:source && npm run verify:scaffold && npm run verify:package && npm run verify:security");
});
