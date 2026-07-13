#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.argv[2] ?? ".");

function resolveStateDir(repoRoot) {
  const candidates = [".agents/agentify", ".claude/agentify", ".pi/agentify"];
  const explicit = [];
  const unstamped = [];
  for (const base of candidates) {
    const manifestPath = path.join(repoRoot, base, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error(`invalid agentify manifest at ${base}/manifest.json`);
    }
    if (parsed && typeof parsed.state_dir === "string") {
      if (parsed.state_dir !== base) {
        throw new Error(`manifest state_dir mismatch at ${base}/manifest.json: ${parsed.state_dir}`);
      }
      explicit.push(base);
    } else {
      unstamped.push(base);
    }
  }
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) {
    throw new Error(`multiple explicit agentify state manifests: ${explicit.join(", ")}`);
  }
  if (unstamped.length === 1) return unstamped[0];
  if (unstamped.length > 1) {
    throw new Error(`multiple unstamped agentify state manifests: ${unstamped.join(", ")}`);
  }
  throw new Error("no agentify manifest found; run agentify before refreshing managed state");
}

const stateDir = resolveStateDir(repoRoot);
const manifestPath = path.join(repoRoot, stateDir, "manifest.json");

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function markerForPath(relativePath) {
  if (relativePath.endsWith(".md")) return "<!-- agentify:managed -->";
  if (relativePath.endsWith(".json")) return "sha256";
  return "# agentify:managed";
}

function kindForPath(relativePath, stateDir) {
  if (relativePath.startsWith(`${stateDir}/prompts/experts/`)) return "expert";
  if (relativePath.startsWith(`${stateDir}/`)) return "state";
  if (/^\.pi\/prompts\/experts\/[^/]+\//.test(relativePath)) return "expert";
  if (relativePath.startsWith(".codex/") || relativePath === "CLAUDE.md") return "harness_export";
  if (relativePath.startsWith(".claude/")) return "skill";
  return "audit";
}

function isRequired(relativePath, mode) {
  const formation = new Set(["GOALS.md", "CONTEXT.md", "SETUP.md", ".github/workflows/agent-implement.yml", ".github/actions/run-pi/action.yml", ".github/scripts/setup-agentify.sh"]);
  const brownfield = new Set(["AGENTS.md", "specs/README.md", "ai_docs/README.md", `${stateDir}/codebase_map.json`, "SETUP.md", ".github/workflows/agent-implement.yml", ".github/actions/run-pi/action.yml", ".github/scripts/setup-agentify.sh"]);
  return (mode === "green" + "field" ? formation : brownfield).has(relativePath);
}

function isRefreshManagedPath(relativePath) {
  if ([
    "AGENTS.md",
    "CLAUDE.md",
    "specs/README.md",
    "ai_docs/README.md",
    ".pi/conditional_docs.md",
  ].includes(relativePath)) return true;
  return relativePath.startsWith(".pi/agents/")
    || /^\.pi\/prompts\/experts\/[^/]+\/expertise\.yaml$/.test(relativePath)
    || relativePath.startsWith(".codex/agents/")
    || relativePath.startsWith(".claude/agents/")
    || relativePath.startsWith("app_docs/")
    || relativePath.startsWith("app_review/")
    || relativePath.startsWith("app_fix_reports/");
}

function carriesMarker(relativePath, content) {
  const marker = markerForPath(relativePath);
  return marker === "sha256" || content.includes(marker);
}

function walk(dir, prefix = "") {
  const absolute = path.join(repoRoot, dir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : `${dir}/${entry.name}`;
    const abs = path.join(repoRoot, rel);
    if (entry.isDirectory()) {
      out.push(...walk(rel, rel));
    } else if (entry.isFile()) {
      out.push(toPosix(rel));
    }
  }
  return out;
}

function candidateFiles() {
  const fixed = ["AGENTS.md", "CLAUDE.md", "specs/README.md", "ai_docs/README.md", ".pi/conditional_docs.md"];
  const trees = [
    ".pi/agents",
    ".pi/prompts/experts",
    ".codex/agents",
    ".claude/agents",
    "app_docs",
    "app_review",
    "app_fix_reports",
  ];
  return [...fixed, ...trees.flatMap((tree) => walk(tree))].filter(isRefreshManagedPath);
}

if (!fs.existsSync(manifestPath)) {
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schema_version !== "1" || !Array.isArray(manifest.files)) {
  throw new Error("invalid agentify manifest");
}

const formationMode = "green" + "field";
const mode = manifest.mode === formationMode ? formationMode : "brownfield";
const byPath = new Map();

for (const file of manifest.files) {
  if (!file || typeof file.path !== "string") continue;
  const rel = toPosix(file.path);
  const abs = path.join(repoRoot, rel);
  if (isRefreshManagedPath(rel)) {
    if (!fs.existsSync(abs)) {
      if (file.required) byPath.set(rel, file);
      continue;
    }
    const content = fs.readFileSync(abs);
    byPath.set(rel, {
      ...file,
      path: rel,
      kind: file.kind ?? kindForPath(rel, stateDir),
      marker: file.marker ?? markerForPath(rel),
      sha256: sha256(content),
    });
    continue;
  }
  byPath.set(rel, { ...file, path: rel });
}

for (const rel of candidateFiles()) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs) || byPath.has(rel)) continue;
  const content = fs.readFileSync(abs);
  const text = content.toString("utf8");
  if (!carriesMarker(rel, text)) continue;
  byPath.set(rel, {
    path: rel,
    kind: kindForPath(rel, stateDir),
    required: isRequired(rel, mode),
    marker: markerForPath(rel),
    sha256: sha256(content),
    source: "refresh-surface",
  });
}

const next = {
  ...manifest,
  generated_at: new Date().toISOString(),
  files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
};

const nextText = `${JSON.stringify(next, null, 2)}\n`;
if (fs.readFileSync(manifestPath, "utf8") !== nextText) {
  fs.writeFileSync(manifestPath, nextText);
}
