import * as fs from "node:fs";

const runtimePath = "src/core/pi-sdk-runtime.ts";
let runtime = fs.readFileSync(runtimePath, "utf-8");

function replaceOnce(label, before, after) {
  if (!runtime.includes(before)) throw new Error(`compiled-package patch '${label}' did not match`);
  runtime = runtime.replace(before, after);
}

replaceOnce(
  "remove fileURLToPath import",
  `import { fileURLToPath } from "node:url";\n`,
  ``,
);
replaceOnce(
  "add package-root resolver",
  `import { shippedSkillsSourceDir } from "./shipped-paths.ts";`,
  `import { shippedSkillsSourceDir } from "./shipped-paths.ts";\nimport { resolvePackageRoot } from "./package-root.ts";`,
);
replaceOnce(
  "resolve package root",
  `const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");`,
  `const PACKAGE_ROOT = resolvePackageRoot();`,
);
fs.writeFileSync(runtimePath, runtime);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
pkg.files = [
  "bin",
  "dist",
  "scaffold",
  "docs",
  "packaged",
  "skills-lock.json",
  "README.md",
  "LICENSE",
  "AGENTS.md",
];
pkg.scripts = {
  ...pkg.scripts,
  build: "node scripts/build.mjs",
  prepack: "npm run build",
  prepublishOnly: "npm run release:check",
};
if (pkg.dependencies) delete pkg.dependencies.jiti;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("compiled package metadata and runtime paths applied");
