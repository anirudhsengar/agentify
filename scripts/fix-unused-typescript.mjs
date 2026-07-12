#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "tsconfig.json");
const UNUSED_CODES = new Set([6133, 6138, 6192, 6196]);
const FORMAT_OPTIONS = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: "\n",
  semicolons: ts.SemicolonPreference.Insert,
};
const USER_PREFERENCES = {
  quotePreference: "double",
};

function readConfig() {
  const loaded = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, ROOT, {
    noUnusedLocals: true,
    noUnusedParameters: true,
  }, CONFIG_PATH);
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost));
  }
  return parsed;
}

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => "\n",
};

const parsed = readConfig();
const versions = new Map(parsed.fileNames.map((fileName) => [fileName, 0]));

const host = {
  getCompilationSettings: () => parsed.options,
  getScriptFileNames: () => [...versions.keys()],
  getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
  getScriptSnapshot: (fileName) => {
    if (!fs.existsSync(fileName)) return undefined;
    return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
  },
  getCurrentDirectory: () => ROOT,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

function findNodeAtPosition(sourceFile, position) {
  let match = sourceFile;
  const visit = (node) => {
    if (position >= node.getFullStart() && position < node.getEnd()) {
      match = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sourceFile);
  return match;
}

function hasParameterAncestor(node) {
  let current = node;
  while (current) {
    if (ts.isParameter(current)) return true;
    current = current.parent;
  }
  return false;
}

function selectFix(diagnostic, fixes) {
  if (fixes.length === 0) return undefined;
  const program = service.getProgram();
  const sourceFile = diagnostic.file && program?.getSourceFile(diagnostic.file.fileName);
  const node = sourceFile && diagnostic.start !== undefined
    ? findNodeAtPosition(sourceFile, diagnostic.start)
    : undefined;
  const parameter = node ? hasParameterAncestor(node) : false;

  if (parameter) {
    const underscoreFix = fixes.find((fix) => /underscore/i.test(fix.description));
    if (underscoreFix) return underscoreFix;
  }

  return fixes.find((fix) => /remove.*unused|delete.*unused/i.test(fix.description)) ?? fixes[0];
}

function applyTextChanges(changes) {
  for (const change of changes) {
    const fileName = path.resolve(change.fileName);
    let text = fs.readFileSync(fileName, "utf-8");
    const sorted = [...change.textChanges].sort((left, right) => right.span.start - left.span.start);
    for (const edit of sorted) {
      text = `${text.slice(0, edit.span.start)}${edit.newText}${text.slice(edit.span.start + edit.span.length)}`;
    }
    fs.writeFileSync(fileName, text);
    versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
  }
}

function unusedDiagnostics() {
  const program = service.getProgram();
  if (!program) throw new Error("TypeScript language service did not produce a program");
  return program.getSemanticDiagnostics()
    .filter((diagnostic) => UNUSED_CODES.has(diagnostic.code) && diagnostic.file && diagnostic.start !== undefined)
    .sort((left, right) => {
      const fileOrder = left.file.fileName.localeCompare(right.file.fileName);
      return fileOrder !== 0 ? fileOrder : left.start - right.start;
    });
}

let applied = 0;
for (let iteration = 0; iteration < 500; iteration += 1) {
  const diagnostics = unusedDiagnostics();
  if (diagnostics.length === 0) break;

  const diagnostic = diagnostics[0];
  const fileName = diagnostic.file.fileName;
  const start = diagnostic.start;
  const fixes = service.getCodeFixesAtPosition(
    fileName,
    start,
    start + (diagnostic.length ?? 0),
    [diagnostic.code],
    FORMAT_OPTIONS,
    USER_PREFERENCES,
  );
  const fix = selectFix(diagnostic, fixes);
  if (!fix) {
    const rendered = ts.formatDiagnostic(diagnostic, formatHost);
    throw new Error(`No safe TypeScript code fix was available:\n${rendered}`);
  }

  applyTextChanges(fix.changes);
  applied += 1;
  process.stdout.write(`applied ${fix.fixName}: ${fix.description}\n`);
}

const remaining = unusedDiagnostics();
if (remaining.length > 0) {
  throw new Error(`Unused-code cleanup did not converge:\n${ts.formatDiagnosticsWithColorAndContext(remaining, formatHost)}`);
}

const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
rawConfig.compilerOptions.noUnusedLocals = true;
rawConfig.compilerOptions.noUnusedParameters = true;
fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(rawConfig, null, 2)}\n`);

const maintenancePath = path.join(ROOT, "tests/maintenance/documentation-invariants.test.ts");
let maintenance = fs.readFileSync(maintenancePath, "utf-8");
const beforeTest = `test("strict TypeScript remains enabled", () => {\n  const config = JSON.parse(read("tsconfig.json")) as TypeScriptConfig;\n  assert.equal(config.compilerOptions?.strict, true);\n});`;
const afterTest = `test("strict TypeScript and unused-code checks remain enabled", () => {\n  const config = JSON.parse(read("tsconfig.json")) as TypeScriptConfig;\n  assert.equal(config.compilerOptions?.strict, true);\n  assert.equal(config.compilerOptions?.noUnusedLocals, true);\n  assert.equal(config.compilerOptions?.noUnusedParameters, true);\n});`;
if (!maintenance.includes(beforeTest)) {
  throw new Error("maintenance invariant marker did not match");
}
maintenance = maintenance.replace(beforeTest, afterTest);
fs.writeFileSync(maintenancePath, maintenance);

const changelogPath = path.join(ROOT, "CHANGELOG.md");
let changelog = fs.readFileSync(changelogPath, "utf-8");
const changedMarker = "- The CLI binary executes `dist/cli.js` directly; `jiti` and runtime TypeScript execution were removed.";
const changedEntry = `${changedMarker}\n- TypeScript now rejects unused locals and parameters across production code and tests.`;
if (!changelog.includes(changedMarker)) {
  throw new Error("changelog insertion marker did not match");
}
changelog = changelog.replace(changedMarker, changedEntry);
fs.writeFileSync(changelogPath, changelog);

process.stdout.write(`unused-code cleanup complete: ${applied} TypeScript code fixes applied\n`);
