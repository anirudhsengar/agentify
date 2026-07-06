#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

const cwd = path.resolve(process.argv[2] ?? ".");
const expertsDir = path.join(cwd, ".pi", "prompts", "experts");
const maxFilesPerExpert = Number.parseInt(process.env["AGENTIFY_STALE_EXPERT_FILE_LIMIT"] ?? "500", 10);

function stripLineRef(value) {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function cleanYamlValue(value) {
  return stripLineRef(value.trim().replace(/^["']|["']$/g, ""));
}

function pushUnique(out, value) {
  const cleaned = cleanYamlValue(value);
  if (cleaned && !out.includes(cleaned)) out.push(cleaned);
}

function readExpertise(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const paths = [];
  let lastUpdated = null;
  for (const line of raw.split(/\r?\n/)) {
    const lastUpdatedMatch = line.match(/^last_updated:\s*(.+?)\s*$/);
    if (lastUpdatedMatch) lastUpdated = cleanYamlValue(lastUpdatedMatch[1]);

    const listItemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (listItemMatch && !listItemMatch[1].includes(":")) pushUnique(paths, listItemMatch[1]);

    const pathMatch = line.match(/^\s*(?:-\s*)?path:\s*(.+?)\s*$/);
    if (pathMatch) pushUnique(paths, pathMatch[1]);

    const refMatch = line.match(/^\s*(?:example_ref|reference):\s*(.+?)\s*$/);
    if (refMatch) pushUnique(paths, refMatch[1]);
  }
  return { lastUpdated, paths };
}

function resolveInsideCwd(relPath) {
  const absolute = path.resolve(cwd, relPath);
  const relative = path.relative(cwd, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

function toPosixRel(absolute) {
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

function collectFiles(relPath, out) {
  if (out.length >= maxFilesPerExpert) return;
  const absolute = resolveInsideCwd(relPath);
  if (absolute === null || !fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    out.push(absolute);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFilesPerExpert) return;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agentify-runtime") continue;
    collectFiles(path.join(relPath, entry.name), out);
  }
}

function inspectExpert(domain) {
  const expertisePath = path.join(expertsDir, domain, "expertise.yaml");
  let expertise;
  try {
    expertise = readExpertise(expertisePath);
  } catch (err) {
    return {
      domain,
      stale: true,
      lastUpdated: null,
      latestChangedPath: null,
      latestChangedAt: null,
      checkedPathCount: 0,
      reason: `expertise.yaml could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const files = [];
  for (const ownedPath of expertise.paths) {
    collectFiles(ownedPath, files);
    if (files.length >= maxFilesPerExpert) break;
  }

  const lastUpdatedMs = expertise.lastUpdated === null ? Number.NaN : Date.parse(expertise.lastUpdated);
  if (!Number.isFinite(lastUpdatedMs)) {
    return {
      domain,
      stale: true,
      lastUpdated: expertise.lastUpdated,
      latestChangedPath: files[0] ? toPosixRel(files[0]) : null,
      latestChangedAt: files[0] ? fs.statSync(files[0]).mtime.toISOString() : null,
      checkedPathCount: files.length,
      reason: "expertise.yaml last_updated is missing or invalid",
    };
  }

  let latestPath = null;
  let latestMtime = 0;
  for (const file of files) {
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > latestMtime) {
      latestMtime = mtime;
      latestPath = file;
    }
  }

  const stale = latestPath !== null && latestMtime > lastUpdatedMs;
  return {
    domain,
    stale,
    lastUpdated: expertise.lastUpdated,
    latestChangedPath: latestPath ? toPosixRel(latestPath) : null,
    latestChangedAt: latestPath ? new Date(latestMtime).toISOString() : null,
    checkedPathCount: files.length,
    reason: stale ? "referenced repository file is newer than expertise.yaml last_updated" : "current",
  };
}

const domains = fs.existsSync(expertsDir)
  ? fs.readdirSync(expertsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  : [];

const inspected = domains.map(inspectExpert);
const report = {
  generatedAt: new Date().toISOString(),
  checked: inspected.length,
  stale: inspected.filter((entry) => entry.stale),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
