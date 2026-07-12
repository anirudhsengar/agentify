import * as fs from "node:fs";

const filePath = "tests/core/state-directory-isolation.test.ts";
let source = fs.readFileSync(filePath, "utf8");
source = source.replace(
  'function tempDir(name: string): string {\n  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));\n}\n',
  'function tempDir(name: string): string {\n  return fs.mkdtempSync(path.join(os.tmpdir(), `agentify-${name}-`));\n}\n\nfunction isToolError(result: unknown): boolean {\n  return (result as { isError?: boolean }).isError === true;\n}\n',
);
source = source
  .replace('assert.notEqual(claudeResult.isError, true);', 'assert.equal(isToolError(claudeResult), false);')
  .replace('assert.notEqual(codexResult.isError, true);', 'assert.equal(isToolError(codexResult), false);')
  .replace('assert.equal(invalid.isError, true);', 'assert.equal(isToolError(invalid), true);')
  .replace('assert.notEqual(result.isError, true);', 'assert.equal(isToolError(result), false);');
fs.writeFileSync(filePath, source);
