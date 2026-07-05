import * as fs from "node:fs";
import * as path from "node:path";
import { addMarkdownManagedMarker, AGENTIFY_MANAGED_MARKERS } from "./artifact-exporters.ts";
import type { ArtifactWrite } from "./types.ts";

const HASH_MARKER = AGENTIFY_MANAGED_MARKERS.toml;
const MARKDOWN_MARKER = AGENTIFY_MANAGED_MARKERS.markdown;

export interface InstallScaffoldRuntimeOptions {
  cwd: string;
  packageRoot: string;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

function markerFor(filePath: string): string {
  return path.extname(filePath) === ".md" ? MARKDOWN_MARKER : HASH_MARKER;
}

function addHashMarker(raw: string): string {
  if (raw.includes(HASH_MARKER)) return raw;
  if (raw.startsWith("#!")) {
    const newline = raw.indexOf("\n");
    if (newline >= 0) {
      return `${raw.slice(0, newline + 1)}${HASH_MARKER}\n${raw.slice(newline + 1)}`;
    }
  }
  return `${HASH_MARKER}\n${raw}`;
}

function addMarker(raw: string, marker: string): string {
  return marker === MARKDOWN_MARKER ? addMarkdownManagedMarker(raw) : addHashMarker(raw);
}

function copyManaged(source: string, destination: string): ArtifactWrite {
  const marker = markerFor(destination);
  const raw = fs.readFileSync(source, "utf-8");
  const content = addMarker(raw, marker);
  if (fs.existsSync(destination)) {
    const existing = fs.readFileSync(destination, "utf-8");
    if (!existing.includes(marker)) {
      return {
        path: destination,
        action: "conflict",
        reason: "existing file is not agentify-managed",
      };
    }
    if (existing === content) {
      return {
        path: destination,
        action: "skipped",
      };
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, { mode: 0o644 });
  return {
    path: destination,
    action: "written",
  };
}

export function installScaffoldRuntime(options: InstallScaffoldRuntimeOptions): ArtifactWrite[] {
  const scaffoldRoot = path.join(options.packageRoot, "scaffold");
  if (!fs.existsSync(scaffoldRoot)) {
    return [];
  }
  const writes: ArtifactWrite[] = [];
  for (const source of listFiles(scaffoldRoot)) {
    const relative = path.relative(scaffoldRoot, source);
    writes.push(copyManaged(source, path.join(options.cwd, relative)));
  }
  return writes;
}
