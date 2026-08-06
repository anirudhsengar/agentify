import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = path.join(ROOT, "src");
const ROOTS = [
  "src/cli.ts",
  "src/core/task-lifecycle/cli.ts",
  "src/core/learning/cli.ts",
] as const;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts)$/.test(entry.name))
    .map((entry) => path.resolve(entry.parentPath, entry.name))
    .sort();
}

function resolveImport(from: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.cts`, path.join(base, "index.ts")]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

test("every TypeScript source file is reachable from an executable root", () => {
  const files = sourceFiles(SOURCE_ROOT);
  const fileSet = new Set(files);
  const dependencies = new Map<string, string[]>();
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = resolveImport(file, node.moduleSpecifier.text, fileSet);
        if (resolved) imports.push(resolved);
      } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        && ts.isStringLiteral(node.arguments[0]!)) {
        const resolved = resolveImport(file, node.arguments[0].text, fileSet);
        if (resolved) imports.push(resolved);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    dependencies.set(file, imports);
  }

  const reachable = new Set<string>();
  const pending = ROOTS.map((root) => path.join(ROOT, root));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(dependencies.get(file) ?? []));
  }
  const unreachable = files
    .filter((file) => !reachable.has(file))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
  assert.deepEqual(unreachable, []);
});

test("standalone scripts are invoked by package metadata", () => {
  const packageJson = fs.readFileSync(path.join(ROOT, "package.json"), "utf-8");
  const scripts = fs.readdirSync(path.join(ROOT, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:mjs|js|ts)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const script of scripts) {
    assert.ok(packageJson.includes(script), `${script} has no package script`);
  }
});
