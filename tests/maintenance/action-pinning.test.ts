import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW_ROOTS = [
  ".github/workflows",
  "scaffold/.github/workflows",
] as const;
const EXTERNAL_ACTION = /^([^/\s]+\/[^@\s]+)@([^\s#]+)$/;
const IMMUTABLE_COMMIT = /^[0-9a-f]{40}$/;

interface ActionUse {
  action: string;
  file: string;
  line: number;
  reference: string;
}

function workflowFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  return fs.readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function externalActionUses(file: string): ActionUse[] {
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      const value = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/u.exec(line)?.[1];
      if (!value || value.startsWith("./")) return [];
      const parsed = EXTERNAL_ACTION.exec(value);
      assert.ok(parsed, `${path.relative(ROOT, file)}:${index + 1} has an invalid external action reference`);
      return [{
        action: parsed[1],
        file: path.relative(ROOT, file).split(path.sep).join("/"),
        line: index + 1,
        reference: parsed[2],
      }];
    });
}

test("repository and scaffold workflows pin external actions to full commit SHAs", () => {
  const uses = WORKFLOW_ROOTS.flatMap((root) => workflowFiles(root).flatMap(externalActionUses));
  assert.ok(uses.length > 0, "expected external GitHub Actions references");

  const mutable = uses.filter(({ reference }) => !IMMUTABLE_COMMIT.test(reference));
  assert.deepEqual(
    mutable,
    [],
    `mutable action references: ${mutable.map(({ action, file, line, reference }) => `${file}:${line} ${action}@${reference}`).join(", ")}`,
  );
});
