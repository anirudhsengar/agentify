import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build, type Plugin } from "esbuild";
// @ts-expect-error plain-JS build helper; no declaration file
import { createSinglePiAiPlugin } from "../../scripts/lib/single-pi-ai-plugin.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

// The probe reproduces the real login path end to end: the CLI registers the
// bundled OAuth flows, then reaches the provider through pi-coding-agent's
// ModelRuntime — whose pi-ai imports resolve (without the single-copy plugin)
// to pi-coding-agent's shrinkwrapped nested copy, where no registration ever
// lands. `toAuth` forces the OAuth flow module load without any network I/O.
const PROBE_REGISTER = 'import { registerBundledOAuthFlows } from "REGISTER_MODULE";\nregisterBundledOAuthFlows();';
const PROBE_BODY = `
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const runtime = await ModelRuntime.create({ modelsPath: "MODELS_PATH", allowModelNetwork: false });
const provider = runtime.getProviders().find((candidate) => candidate.id === "openai-codex");
if (!provider?.auth?.oauth) throw new Error("openai-codex provider lost its OAuth definition");
const auth = await provider.auth.oauth.toAuth({ access: "probe" });
if (auth.apiKey !== "probe") throw new Error("OAuth flow toAuth returned an unexpected shape");
console.log("bundled-oauth-flow-ok");
`;

interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function bundleAndRun(options: { register: boolean; singleCopy: boolean }): Promise<ProbeResult> {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "agentify-oauth-bundle-"));
  try {
    const registerModule = path.join(root, "src", "core", "register-bundled-oauth-flows.ts");
    const source = [
      options.register ? PROBE_REGISTER.replace("REGISTER_MODULE", registerModule) : "",
      PROBE_BODY.replace("MODELS_PATH", path.join(workdir, "models-store.json")),
    ].join("\n");
    const entryPath = path.join(workdir, "fixture-entry.ts");
    const outfile = path.join(workdir, "fixture-bundle.mjs");
    await writeFile(entryPath, source, "utf8");
    const plugins: Plugin[] = [];
    if (options.singleCopy) {
      plugins.push(createSinglePiAiPlugin(root) as Plugin);
    }
    await build({
      entryPoints: [entryPath],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: {
        // Same createRequire shim as scripts/build.mjs; CJS deps (cross-spawn
        // et al.) require() node builtins at module scope.
        js: 'import { createRequire as __agentifyCreateRequire } from "node:module"; const require = __agentifyCreateRequire(import.meta.url);',
      },
      logLevel: "silent",
      nodePaths: [path.join(root, "node_modules")],
      plugins,
    });
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [outfile]);
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

test("bundled OAuth flows resolve through pi-coding-agent's ModelRuntime", async () => {
  const result = await bundleAndRun({ register: true, singleCopy: true });
  assert.equal(
    result.code,
    0,
    `bundled OAuth probe must succeed; stderr: ${result.stderr.slice(0, 500)}`,
  );
  assert.match(result.stdout, /bundled-oauth-flow-ok/u);
});

test("without flow registration the probe cannot resolve the flow (negative control)", async () => {
  const result = await bundleAndRun({ register: false, singleCopy: true });
  assert.notEqual(result.code, 0, "unregistered bundle must fail to resolve the OAuth flow");
  assert.match(
    result.stderr,
    /Cannot find module|ERR_MODULE_NOT_FOUND/u,
    `expected a module-resolution failure, got: ${result.stderr.slice(0, 500)}`,
  );
});

test("without the single-copy plugin, registration lands on the wrong pi-ai instance", async () => {
  // The reported commander.js-era failure: pi-coding-agent's shrinkwrapped
  // nested pi-ai copy stays unregistered, so the ModelRuntime path crashes
  // with `Cannot find module dist/openai-codex.js` even though the entry point
  // called registerBundledOAuthFlows().
  const result = await bundleAndRun({ register: true, singleCopy: false });
  assert.notEqual(result.code, 0, "dual-copy bundle must fail on the ModelRuntime path");
  assert.match(
    result.stderr,
    /Cannot find module|ERR_MODULE_NOT_FOUND/u,
    `expected a module-resolution failure, got: ${result.stderr.slice(0, 500)}`,
  );
});

test("every bundled entry point registers the OAuth flows", async () => {
  const entries = [
    path.join(root, "src", "cli.ts"),
    path.join(root, "src", "core", "task-lifecycle", "cli.ts"),
    path.join(root, "src", "core", "learning", "cli.ts"),
  ];
  for (const entry of entries) {
    const source = await readFile(entry, "utf8");
    assert.match(
      source,
      /import \{ registerBundledOAuthFlows \} from "([^"]*register-bundled-oauth-flows\.ts)";/u,
      `${path.basename(entry)} must import registerBundledOAuthFlows`,
    );
    assert.match(
      source,
      /^registerBundledOAuthFlows\(\);/mu,
      `${path.basename(entry)} must call registerBundledOAuthFlows() at module scope so OAuth login/refresh resolve in the self-contained bundle`,
    );
  }
});

test("the production build applies the single-pi-ai plugin", async () => {
  const buildScript = await readFile(path.join(root, "scripts", "build.mjs"), "utf8");
  assert.match(buildScript, /createSinglePiAiPlugin/u);
  assert.match(buildScript, /plugins: \[singlePiAiPlugin\]/u);
});
