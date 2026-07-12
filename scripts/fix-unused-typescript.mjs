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
const USER_PREFERENCES = { quotePreference: "double" };
const FIX_IDS = [
  "unusedIdentifier_deleteImports",
  "unusedIdentifier_prefix",
  "unusedIdentifier_delete",
];

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => "\n",
};

function readConfig(overrides = {}) {
  const loaded = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    ROOT,
    overrides,
    CONFIG_PATH,
  );
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost));
  }
  return parsed;
}

const parsed = readConfig({ noUnusedLocals: true, noUnusedParameters: true });
const versions = new Map(parsed.fileNames.map((fileName) => [path.resolve(fileName), 0]));
const host = {
  getCompilationSettings: () => parsed.options,
  getScriptFileNames: () => [...versions.keys()],
  getScriptVersion: (fileName) => String(versions.get(path.resolve(fileName)) ?? 0),
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

function unusedDiagnostics() {
  const program = service.getProgram();
  if (!program) throw new Error("TypeScript language service did not produce a program");
  return program.getSemanticDiagnostics()
    .filter((diagnostic) => UNUSED_CODES.has(diagnostic.code) && diagnostic.file)
    .sort((left, right) => {
      const fileOrder = left.file.fileName.localeCompare(right.file.fileName);
      return fileOrder !== 0 ? fileOrder : (left.start ?? 0) - (right.start ?? 0);
    });
}

function applyTextChanges(changes) {
  let editCount = 0;
  for (const change of changes) {
    const fileName = path.resolve(change.fileName);
    let text = fs.readFileSync(fileName, "utf-8");
    const sorted = [...change.textChanges].sort((left, right) => right.span.start - left.span.start);
    for (const edit of sorted) {
      text = `${text.slice(0, edit.span.start)}${edit.newText}${text.slice(edit.span.start + edit.span.length)}`;
      editCount += 1;
    }
    if (sorted.length > 0) {
      fs.writeFileSync(fileName, text);
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
    }
  }
  return editCount;
}

let appliedEdits = 0;
for (let cycle = 0; cycle < 6; cycle += 1) {
  const before = unusedDiagnostics();
  if (before.length === 0) break;
  let cycleEdits = 0;

  for (const fixId of FIX_IDS) {
    const fileNames = [...new Set(unusedDiagnostics().map((diagnostic) => diagnostic.file.fileName))];
    for (const fileName of fileNames) {
      const combined = service.getCombinedCodeFix(
        { type: "file", fileName },
        fixId,
        FORMAT_OPTIONS,
        USER_PREFERENCES,
      );
      const edits = applyTextChanges(combined.changes);
      if (edits > 0) {
        process.stdout.write(`${fixId}: ${path.relative(ROOT, fileName)} (${edits} edits)\n`);
        cycleEdits += edits;
        appliedEdits += edits;
      }
    }
  }

  const after = unusedDiagnostics();
  process.stdout.write(`cycle ${cycle + 1}: ${before.length} -> ${after.length} diagnostics\n`);
  if (after.length > 0 && cycleEdits === 0) {
    throw new Error(`Compiler fixes made no progress:\n${ts.formatDiagnosticsWithColorAndContext(after, formatHost)}`);
  }
}

const workflowsPath = path.join(ROOT, "tests/aiw/workflows.test.ts");
let workflows = fs.readFileSync(workflowsPath, "utf-8");
workflows = workflows
  .replace("  let reviewPathSeen: string | null = null;\n", "")
  .replace("      reviewPathSeen = reviewPath;\n", "");
fs.writeFileSync(workflowsPath, workflows);

const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
rawConfig.compilerOptions.noUnusedLocals = true;
rawConfig.compilerOptions.noUnusedParameters = true;
fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(rawConfig, null, 2)}\n`);

const maintenancePath = path.join(ROOT, "tests/maintenance/documentation-invariants.test.ts");
let maintenance = fs.readFileSync(maintenancePath, "utf-8");
const beforeInterface = `interface TypeScriptConfig {\n  compilerOptions?: {\n    strict?: boolean;\n  };\n}`;
const afterInterface = `interface TypeScriptConfig {\n  compilerOptions?: {\n    strict?: boolean;\n    noUnusedLocals?: boolean;\n    noUnusedParameters?: boolean;\n  };\n}`;
if (!maintenance.includes(beforeInterface)) throw new Error("TypeScriptConfig interface marker did not match");
maintenance = maintenance.replace(beforeInterface, afterInterface);
const beforeTest = `test("strict TypeScript remains enabled", () => {\n  const config = JSON.parse(read("tsconfig.json")) as TypeScriptConfig;\n  assert.equal(config.compilerOptions?.strict, true);\n});`;
const afterTest = `test("strict TypeScript and unused-code checks remain enabled", () => {\n  const config = JSON.parse(read("tsconfig.json")) as TypeScriptConfig;\n  assert.equal(config.compilerOptions?.strict, true);\n  assert.equal(config.compilerOptions?.noUnusedLocals, true);\n  assert.equal(config.compilerOptions?.noUnusedParameters, true);\n});`;
if (!maintenance.includes(beforeTest)) throw new Error("maintenance invariant marker did not match");
fs.writeFileSync(maintenancePath, maintenance.replace(beforeTest, afterTest));

const changelogPath = path.join(ROOT, "CHANGELOG.md");
let changelog = fs.readFileSync(changelogPath, "utf-8");
const changedMarker = "- The CLI binary executes `dist/cli.js` directly; `jiti` and runtime TypeScript execution were removed.";
const changedEntry = `${changedMarker}\n- TypeScript now rejects unused locals and parameters across production code and tests.`;
if (!changelog.includes(changedMarker)) throw new Error("changelog insertion marker did not match");
fs.writeFileSync(changelogPath, changelog.replace(changedMarker, changedEntry));

const finalConfig = readConfig();
const finalProgram = ts.createProgram(finalConfig.fileNames, finalConfig.options);
const finalDiagnostics = ts.getPreEmitDiagnostics(finalProgram);
if (finalDiagnostics.length > 0) {
  throw new Error(`Generated cleanup does not typecheck:\n${ts.formatDiagnosticsWithColorAndContext(finalDiagnostics, formatHost)}`);
}

process.stdout.write(`unused-code cleanup complete: ${appliedEdits} compiler edits applied\n`);
