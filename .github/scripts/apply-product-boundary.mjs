import * as fs from "node:fs";

function replaceOnce(file, label, before, after) {
  const source = fs.readFileSync(file, "utf-8");
  if (!source.includes(before)) throw new Error(`product-boundary patch '${label}' did not match ${file}`);
  fs.writeFileSync(file, source.replace(before, after));
}

replaceOnce(
  "src/core/aiw/index.ts",
  "AIW composition root header",
  `// src/core/aiw/index.ts — AIW public surface.\n\n// Re-export all public types, schemas, and functions so tests and\n// future CLI integration have a single import point.`,
  `/**\n * @experimental Internal AIW composition root.\n *\n * This module is not a public CLI command or package export and carries no\n * semantic-version compatibility guarantee. Repository tests and internal code\n * may import it directly; package consumers must use the supported \`agentify\`\n * executable. See \`docs/experimental-surfaces.md\`.\n */`,
);
replaceOnce(
  "src/core/aiw/index.ts",
  "remove AIW self export",
  `export type {} from "./index.ts";\n`,
  ``,
);

replaceOnce(
  "README.md",
  "public surface introduction",
  `The installed CLI has a single runtime entrypoint: \`agentify\`. It\nhandles first-run bootstrap, attaches to initialized repos on later runs,\nand recovers partial setup. Lower-level webhook, AIW, orchestrator,\ncommunications, and Agent Expert surfaces remain library-only modules and\nare never public subcommands.`,
  `The installed \`agentify\` command is the only supported public runtime\nsurface in 0.1.x. It handles first-run bootstrap, attaches to initialized\nrepos on later runs, and recovers partial setup. Webhook, AIW, orchestrator,\ncommunications, and Agent Expert modules are internal experimental\nimplementation details: they are not package exports, public commands, or\nsemantic-versioned APIs. See [docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
);

replaceOnce(
  "README.md",
  "automation section",
  `### Automation and orchestration APIs\n\nThe webhook intake/worker, AIW workflows, orchestrator host/tools, communications\nserver, and Agent Expert runtime remain library modules under \`src/core/\`. They\nare never exposed as public subcommands by \`src/cli.ts\`; the supported\noperational path is the generated GitHub issue/comment/PR loop.`,
  `### Internal experimental runtimes\n\nWebhook intake/worker, AIW workflows, orchestrator host/tools, communications,\nand Agent Expert code remain internal experimental modules under \`src/core/\`.\nTheir presence and repository test coverage do not make them supported library\nAPIs. They have no package exports or compatibility guarantee. The supported\noperational path is the installed CLI plus the generated GitHub issue/comment/PR\nloop. Graduation requirements are defined in\n[docs/experimental-surfaces.md](docs/experimental-surfaces.md).`,
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

console.log("product boundary patches applied");
