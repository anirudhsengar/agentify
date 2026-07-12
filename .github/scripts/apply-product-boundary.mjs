import * as fs from "node:fs";

function replacePattern(file, label, pattern, replacement, alreadyApplied) {
  const source = fs.readFileSync(file, "utf-8");
  if (alreadyApplied?.test(source)) {
    console.log(`already applied: ${label}`);
    return;
  }
  if (!pattern.test(source)) {
    throw new Error(`product-boundary patch '${label}' did not match ${file}`);
  }
  fs.writeFileSync(file, source.replace(pattern, replacement));
  console.log(`applied: ${label}`);
}

replacePattern(
  "src/core/aiw/index.ts",
  "AIW composition root header",
  /^\/\/ index\.ts — the AIW module's public surface\.\r?\n/m,
  `/**\n * @experimental Internal AIW composition root.\n *\n * This module is not a public CLI command or package export and carries no\n * semantic-version compatibility guarantee. Repository tests and internal code\n * may import it directly; package consumers must use the supported \`agentify\`\n * executable. See \`docs/experimental-surfaces.md\`.\n */\n`,
  /@experimental Internal AIW composition root/,
);
replacePattern(
  "src/core/aiw/index.ts",
  "AIW export heading",
  /^\/\/ Public exports$/m,
  "// Internal experimental exports",
  /^\/\/ Internal experimental exports$/m,
);
replacePattern(
  "src/core/aiw/index.ts",
  "remove AIW self export",
  /\n\/\/ Re-export our own runner types so callers can import from a single entry\.\r?\nexport type \{\} from "\.\/index\.ts";\r?\n?$/,
  "\n",
  /^(?![\s\S]*export type \{\} from "\.\/index\.ts";)[\s\S]*$/,
);

replacePattern(
  "README.md",
  "public surface introduction",
  /agentify exposes one public entrypoint and hides the rest of the\r?\nmachinery behind it\./,
  `The installed \`agentify\` command is the only supported public runtime surface\nin 0.1.x. Internal runtime modules are experimental implementation details, not\npackage APIs or hidden command families. See\n[docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
  /only supported public runtime surface\s+in 0\.1\.x/,
);
replacePattern(
  "README.md",
  "command surface boundary",
  /classification for ambiguous repos\. Internal runtimes \(`webhook`,\r?\n`aiw`, `orchestrator`, `expert`\) are library-only and never appear as\r?\nsubcommands\. See the entry-mode and slot design notes in\r?\n`docs\/README\.md`\./,
  `classification for ambiguous repos. Internal experimental runtimes\n(\`webhook\`, \`aiw\`, \`orchestrator\`, \`coms\`, \`expert\`) are not public\nsubcommands or package exports. See\n[docs/experimental-surfaces.md](docs/experimental-surfaces.md) and the entry-mode\nnotes in \`docs/README.md\`.`,
  /Internal experimental runtimes[\s\S]*?docs\/experimental-surfaces\.md/,
);
replacePattern(
  "README.md",
  "troubleshooting boundary",
  /Webhook, AIW, orchestrator, and expert modules may still exist\r?\ninternally\. The public GitHub loop uses generated workflow\/specialist\/expert\r?\ncontext plus the orchestration-planner prompt; it does not expose the internal\r?\nOrchestratorHost as a public command or hosted control plane\. See\r?\nthe public orchestration-plane boundary as documented in\r?\n`docs\/README\.md`\./,
  `Webhook, AIW, orchestrator, communications, and expert modules remain internal\nexperimental code. The public GitHub loop uses generated\nworkflow/specialist/expert context plus the orchestration-planner prompt; it does\nnot expose an internal host as a public command, library API, or hosted control\nplane. See [docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
  /communications, and expert modules remain internal\s+experimental code/,
);

const packagePath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
packageJson.exports = { "./package.json": "./package.json" };
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log("applied: restrictive package exports");

replacePattern(
  "tests/product-boundary.test.ts",
  "restrict package exports assertion",
  /  assert\.equal\(packageJson\.exports, undefined, "experimental modules must not be package exports"\);/,
  `  assert.deepEqual(\n    packageJson.exports,\n    { "./package.json": "./package.json" },\n    "the package export map must reject deep imports into experimental source",\n  );`,
  /the package export map must reject deep imports/,
);

replacePattern(
  "docs/experimental-surfaces.md",
  "boundary enforcement wording",
  /The current enforcement boundary is the absence of package exports, the explicit\r?\nCLI parser, documentation, and product-boundary tests\. Raw source may still be\r?\npresent in 0\.1\.x packages until the compiled-package remediation lands; its\r?\npresence does not make deep imports supported or stable\./,
  `The restrictive npm \`exports\` map, documentation, CLI parser, and\nproduct-boundary tests enforce this boundary. Standard package imports into raw\nsource paths are rejected. The compiled-artifact packaging phase will additionally\nremove raw TypeScript source from the published tarball.`,
  /restrictive npm `exports` map/,
);

console.log("product boundary patches applied");
