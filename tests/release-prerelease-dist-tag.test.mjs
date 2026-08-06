import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const workflow = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/release-publish.yml"),
  "utf8",
);

function jobBlock(jobName, nextJob) {
  const startMarker = `\n  ${jobName}:`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow job: ${jobName}`);
  const end = nextJob
    ? workflow.indexOf(`\n  ${nextJob}:`, start + startMarker.length)
    : workflow.length;
  assert.ok(end > start, `could not isolate workflow job: ${jobName}`);
  return workflow.slice(start, end);
}

test("npm prereleases use next while stable releases use latest", () => {
  const publish = jobBlock("publish-npm", "github-release");
  const release = jobBlock("github-release");

  assert.match(publish, /npm_tag=latest/);
  assert.match(publish, /if \[\[ "\$\{GITHUB_REF_NAME\}" == \*-\* \]\]; then/);
  assert.match(publish, /npm_tag=next/);
  assert.match(
    publish,
    /npm publish "\$\{tarballs\[0\]\}" --provenance --access public --tag "\$npm_tag"/,
  );
  assert.match(release, /prerelease: \$\{\{ contains\(github\.ref_name, '-'\) \}\}/);
});

test("manual verification remains unable to publish", () => {
  const publish = jobBlock("publish-npm", "github-release");
  assert.match(publish, /github\.event_name == 'push'/);
  assert.match(publish, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});
