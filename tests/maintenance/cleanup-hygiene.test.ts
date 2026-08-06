import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("repository excludes generated and credential-bearing state", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".agentify")), false);
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf-8");
  assert.match(ignore, /^\.agentify\/$/m);
  assert.match(ignore, /^\.env$/m);
});

test("source files have no empty trailing line blocks", () => {
  for (const relativeRoot of ["src", "scripts", "tests"]) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    for (const entry of fs.readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|js|mjs)$/.test(entry.name)) continue;
      const filePath = path.join(entry.parentPath, entry.name);
      const text = fs.readFileSync(filePath, "utf-8").replaceAll("\r\n", "\n");
      assert.doesNotMatch(text, /\n{4,}$/, path.relative(ROOT, filePath));
    }
  }
});
