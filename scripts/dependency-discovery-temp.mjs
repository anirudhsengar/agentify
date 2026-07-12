#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outputDir = path.join(root, "dependency-discovery-output");
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeout ?? 600_000,
    env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function npmView(spec, field) {
  const raw = run("npm", ["view", spec, field, "--json"]);
  if (!raw) return null;
  return JSON.parse(raw);
}

function latestMatching(spec) {
  const value = npmView(spec, "version");
  return Array.isArray(value) ? value.at(-1) : value;
}

function lockPackageName(lockPath) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath;
}

function lockSnapshot(lock) {
  const result = new Map();
  for (const [lockPath, value] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || !value || typeof value !== "object") continue;
    const name = lockPackageName(lockPath);
    const key = `${lockPath}`;
    result.set(key, {
      path: lockPath,
      name,
      version: value.version ?? null,
      resolved: value.resolved ?? null,
      integrity: value.integrity ?? null,
      engines: value.engines ?? null,
      dependencies: value.dependencies ?? null,
      optionalDependencies: value.optionalDependencies ?? null,
      peerDependencies: value.peerDependencies ?? null,
    });
  }
  return result;
}

function diffSnapshots(before, after) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of keys) {
    const a = before.get(key);
    const b = after.get(key);
    if (!a && b) {
      added.push(b);
      continue;
    }
    if (a && !b) {
      removed.push(a);
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push({ path: key, before: a, after: b });
    }
  }
  return { added, removed, changed };
}

function occurrences(lock, packageName) {
  return Object.entries(lock.packages ?? {})
    .filter(([lockPath]) => lockPath === `node_modules/${packageName}` || lockPath.endsWith(`/node_modules/${packageName}`))
    .map(([lockPath, value]) => ({
      path: lockPath,
      version: value.version ?? null,
      engines: value.engines ?? null,
      dependencies: value.dependencies ?? null,
    }));
}

function auditSummary(cwd) {
  const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, npm_config_fund: "false" },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = { parse_error: true, stdout: result.stdout, stderr: result.stderr };
  }
  return {
    exitStatus: result.status,
    metadata: parsed?.metadata ?? null,
    vulnerabilities: parsed?.vulnerabilities ?? null,
    error: parsed?.error ?? null,
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const baselineLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const baselineSnapshot = lockSnapshot(baselineLock);

const currentResolved = {};
for (const name of [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "typebox",
  "typescript",
  "@types/node",
  "esbuild",
  "tsx",
  "@smithy/util-buffer-from",
]) {
  currentResolved[name] = occurrences(baselineLock, name);
}

const candidateVersions = {
  "@earendil-works/pi-ai": latestMatching("@earendil-works/pi-ai"),
  "@earendil-works/pi-coding-agent": latestMatching("@earendil-works/pi-coding-agent"),
  typebox: latestMatching("typebox"),
  typescript: latestMatching("typescript"),
  "@types/node-latest": latestMatching("@types/node"),
  "@types/node-24": latestMatching("@types/node@24"),
  esbuild: latestMatching("esbuild"),
  tsx: latestMatching("tsx"),
  "@smithy/util-buffer-from": latestMatching("@smithy/util-buffer-from"),
};

const metadataSpecs = new Map([
  ["@earendil-works/pi-ai", candidateVersions["@earendil-works/pi-ai"]],
  ["@earendil-works/pi-coding-agent", candidateVersions["@earendil-works/pi-coding-agent"]],
  ["typebox", candidateVersions.typebox],
  ["typescript", candidateVersions.typescript],
  ["@types/node", candidateVersions["@types/node-24"]],
  ["esbuild", candidateVersions.esbuild],
  ["tsx", candidateVersions.tsx],
  ["@smithy/util-buffer-from", candidateVersions["@smithy/util-buffer-from"]],
]);

const registryMetadata = {};
for (const [name, candidate] of metadataSpecs) {
  const current = currentResolved[name]?.[0]?.version ?? null;
  const timeMap = npmView(name, "time") ?? {};
  const latestManifest = npmView(`${name}@${candidate}`, "dist-tags engines dependencies peerDependencies optionalDependencies repository homepage bugs license deprecated dist.tarball");
  const currentManifest = current
    ? npmView(`${name}@${current}`, "engines dependencies peerDependencies optionalDependencies repository homepage bugs license deprecated dist.tarball")
    : null;
  registryMetadata[name] = {
    declared: manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? manifest.overrides?.[name] ?? null,
    current,
    candidate,
    currentPublishedAt: current ? timeMap[current] ?? null : null,
    candidatePublishedAt: timeMap[candidate] ?? null,
    latestTag: (npmView(name, "dist-tags") ?? {}).latest ?? null,
    currentManifest,
    candidateManifest: latestManifest,
  };
}

function simulate({ id, installs = [], dev = false, mutateManifest }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `agentify-deps-${id}-`));
  try {
    fs.copyFileSync(path.join(root, "package.json"), path.join(temp, "package.json"));
    fs.copyFileSync(path.join(root, "package-lock.json"), path.join(temp, "package-lock.json"));
    if (mutateManifest) {
      const tempManifestPath = path.join(temp, "package.json");
      const tempManifest = JSON.parse(fs.readFileSync(tempManifestPath, "utf8"));
      mutateManifest(tempManifest);
      fs.writeFileSync(tempManifestPath, `${JSON.stringify(tempManifest, null, 2)}\n`);
    }
    if (installs.length > 0) {
      run(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--save-exact",
          dev ? "--save-dev" : "--save",
          ...installs,
        ],
        { cwd: temp },
      );
    } else {
      run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temp });
    }
    const newManifest = JSON.parse(fs.readFileSync(path.join(temp, "package.json"), "utf8"));
    const newLock = JSON.parse(fs.readFileSync(path.join(temp, "package-lock.json"), "utf8"));
    return {
      id,
      installs,
      manifestDependencies: newManifest.dependencies ?? {},
      manifestDevDependencies: newManifest.devDependencies ?? {},
      overrides: newManifest.overrides ?? {},
      diff: diffSnapshots(baselineSnapshot, lockSnapshot(newLock)),
      trackedOccurrences: Object.fromEntries(
        Object.keys(currentResolved).map((name) => [name, occurrences(newLock, name)]),
      ),
      audit: auditSummary(temp),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const simulations = [
  simulate({
    id: "typescript-node-types",
    dev: true,
    installs: [
      `typescript@${candidateVersions.typescript}`,
      `@types/node@${candidateVersions["@types/node-24"]}`,
    ],
  }),
  simulate({
    id: "build-tooling",
    dev: true,
    installs: [`esbuild@${candidateVersions.esbuild}`, `tsx@${candidateVersions.tsx}`],
  }),
  simulate({
    id: "typebox",
    installs: [`typebox@${candidateVersions.typebox}`],
  }),
  simulate({
    id: "pi-runtime-pair",
    installs: [
      `@earendil-works/pi-ai@${candidateVersions["@earendil-works/pi-ai"]}`,
      `@earendil-works/pi-coding-agent@${candidateVersions["@earendil-works/pi-coding-agent"]}`,
    ],
  }),
  simulate({
    id: "security-override-removal",
    mutateManifest(tempManifest) {
      if (tempManifest.overrides) {
        delete tempManifest.overrides["@smithy/util-buffer-from"];
        if (Object.keys(tempManifest.overrides).length === 0) delete tempManifest.overrides;
      }
    },
  }),
];

const baseline = {
  manifest: {
    engines: manifest.engines,
    dependencies: manifest.dependencies,
    devDependencies: manifest.devDependencies,
    overrides: manifest.overrides,
  },
  currentResolved,
  audit: auditSummary(root),
};

fs.writeFileSync(path.join(outputDir, "registry-metadata.json"), `${JSON.stringify({ candidateVersions, registryMetadata }, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, "lock-simulations.json"), `${JSON.stringify(simulations, null, 2)}\n`);

console.log(JSON.stringify({
  candidateVersions,
  baselineAudit: baseline.audit.metadata?.vulnerabilities ?? baseline.audit,
  simulations: simulations.map((entry) => ({
    id: entry.id,
    added: entry.diff.added.length,
    removed: entry.diff.removed.length,
    changed: entry.diff.changed.length,
    audit: entry.audit.metadata?.vulnerabilities ?? entry.audit,
  })),
}, null, 2));
