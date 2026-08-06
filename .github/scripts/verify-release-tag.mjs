#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const semverTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const match = semverTag.exec(tag);
if (!match) {
  console.error(`release tag must be valid semver prefixed with v: ${tag || "<empty>"}`);
  process.exit(1);
}

const packagePath = path.resolve("package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
const tagVersion = tag.slice(1);
if (packageVersion !== tagVersion) {
  console.error(`release tag ${tag} does not match package.json version ${packageVersion || "<missing>"}`);
  process.exit(1);
}

console.log(`release tag verified: ${tag}`);
