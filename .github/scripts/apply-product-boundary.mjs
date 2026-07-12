import * as fs from "node:fs";

function replaceOnce(file, label, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (!source.includes(before)) {
    throw new Error(`product-boundary patch '${label}' did not match ${file}`);
  }
  fs.writeFileSync(file, source.replace(before, after));
}

replaceOnce(
  "src/core/aiw/index.ts",
  "AIW composition root header",
  `// index.ts — the AIW module's public surface.\n`,
  `/**\n * @experimental Internal AIW composition root.\n *\n * This module is not a public CLI command or package export and carries no\n * semantic-version compatibility guarantee. Repository tests and internal code\n * may import it directly; package consumers must use the supported \`agentify\`\n * executable. See \`docs/experimental-surfaces.md\`.\n */\n`,
);
replaceOnce(
  "src/core/aiw/index.ts",
  "AIW export heading",
  `// Public exports\n`,
  `// Internal experimental exports\n`,
);
replaceOnce(
  "src/core/aiw/index.ts",
  "remove AIW self export",
  `// Re-export our own runner types so callers can import from a single entry.\nexport type {} from "./index.ts";\n`,
  ``,
);

replaceOnce(
  "README.md",
  "public surface introduction",
  `agentify exposes one public entrypoint and hides the rest of the\nmachinery behind it.`,
  `The installed \`agentify\` command is the only supported public runtime surface\nin 0.1.x. Internal runtime modules are experimental implementation details, not\npackage APIs or hidden command families. See\n[docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
);
replaceOnce(
  "README.md",
  "command surface boundary",
  `classification for ambiguous repos. Internal runtimes (\`webhook\`,\n\`aiw\`, \`orchestrator\`, \`expert\`) are library-only and never appear as\nsubcommands. See the entry-mode and slot design notes in\n\`docs/README.md\`.`,
  `classification for ambiguous repos. Internal experimental runtimes\n(\`webhook\`, \`aiw\`, \`orchestrator\`, \`coms\`, \`expert\`) are not public\nsubcommands or package exports. See\n[docs/experimental-surfaces.md](docs/experimental-surfaces.md) and the entry-mode\nnotes in \`docs/README.md\`.`,
);
replaceOnce(
  "README.md",
  "troubleshooting boundary",
  `Webhook, AIW, orchestrator, and expert modules may still exist\ninternally. The public GitHub loop uses generated workflow/specialist/expert\ncontext plus the orchestration-planner prompt; it does not expose the internal\nOrchestratorHost as a public command or hosted control plane. See\nthe public orchestration-plane boundary as documented in\n\`docs/README.md\`.`,
  `Webhook, AIW, orchestrator, communications, and expert modules remain internal\nexperimental code. The public GitHub loop uses generated\nworkflow/specialist/expert context plus the orchestration-planner prompt; it does\nnot expose an internal host as a public command, library API, or hosted control\nplane. See [docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
);

const packagePath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
packageJson.exports = {
  "./package.json": "./package.json",
};
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

replaceOnce(
  "tests/product-boundary.test.ts",
  "restrict package exports",
  `  assert.equal(packageJson.exports, undefined, "experimental modules must not be package exports");`,
  `  assert.deepEqual(\n    packageJson.exports,\n    { "./package.json": "./package.json" },\n    "the package export map must reject deep imports into experimental source",\n  );`,
);

replaceOnce(
  "docs/experimental-surfaces.md",
  "boundary enforcement wording",
  `The npm package boundary, documentation, CLI parser, and product-boundary tests\nare the enforcement mechanism. The packaging build excludes raw TypeScript source\nfrom the published artifact, preventing deep imports from becoming accidental\nAPIs.`,
  `The restrictive npm \`exports\` map, documentation, CLI parser, and\nproduct-boundary tests enforce this boundary. Standard package imports into raw\nsource paths are rejected. The compiled-artifact packaging phase will additionally\nremove raw TypeScript source from the published tarball.`,
);

console.log("product boundary patches applied");
