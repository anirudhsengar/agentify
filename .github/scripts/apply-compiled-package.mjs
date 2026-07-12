import * as fs from "node:fs";

function replaceOnce(file, label, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (source.includes(after)) {
    console.log(`already applied: ${label}`);
    return;
  }
  if (!source.includes(before)) {
    throw new Error(`compiled-package patch '${label}' did not match ${file}`);
  }
  fs.writeFileSync(file, source.replace(before, after));
  console.log(`applied: ${label}`);
}

const packagePath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
packageJson.files = packageJson.files.map((entry) => (entry === "src" ? "dist" : entry));
delete packageJson.dependencies.jiti;
packageJson.scripts.build = "node scripts/build.mjs";
packageJson.scripts.prepack = "npm run build";
packageJson.scripts.prepublishOnly = "npm run release:check";
packageJson.scripts["inspect-log"] = "node dist/core/audit/scripts/inspect-log.mjs";
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log("applied: package metadata");

replaceOnce(
  ".github/workflows/release-publish.yml",
  "explicit release build",
  "      - name: Build release tarball\n        run: npm pack --ignore-scripts",
  "      - name: Build release tarball\n        run: npm run build && npm pack --ignore-scripts",
);

replaceOnce(
  "docs/README.md",
  "packaging documentation index",
  "| Verified artifact release process | `docs/release-process.md` |",
  "| Verified artifact release process | `docs/release-process.md` |\n| Compiled npm package contract | `docs/packaging.md` |",
);

replaceOnce(
  "docs/experimental-surfaces.md",
  "compiled package enforcement",
  "The restrictive npm `exports` map, documentation, CLI parser, and\nproduct-boundary tests enforce this boundary. Standard package imports into raw\nsource paths are rejected. The compiled-artifact packaging phase will additionally\nremove raw TypeScript source from the published tarball.",
  "The restrictive npm `exports` map, documentation, CLI parser, and\nproduct-boundary tests enforce this boundary. Standard package imports into raw\nsource paths are rejected, and the published tarball contains compiled JavaScript\nunder `dist/` rather than raw TypeScript implementation source.",
);

console.log("compiled package metadata applied");
