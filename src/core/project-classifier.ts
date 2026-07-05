import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectKind } from "./types.ts";

const MANIFEST_FILES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "deno.json",
  "bun.lockb",
]);

const SOURCE_DIRS = new Set([
  "src",
  "app",
  "lib",
  "server",
  "client",
  "pages",
  "components",
  "packages",
  "services",
  "cmd",
  "internal",
  "pkg",
]);

const GREENFIELD_TOP_LEVEL = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  "README",
  "README.md",
  "README.txt",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "docs",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
]);

export interface ProjectClassification {
  kind: ProjectKind;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasMeaningfulGitHistory(cwd: string): boolean {
  const gitHead = path.join(cwd, ".git", "HEAD");
  if (!fs.existsSync(gitHead)) return false;
  const refs = path.join(cwd, ".git", "refs", "heads");
  return safeReaddir(refs).length > 0;
}

function countCodeFiles(cwd: string, maxDepth = 3): number {
  let count = 0;
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || count >= 3) return;
    for (const entry of safeReaddir(dir)) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".venv") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
        count += 1;
        if (count >= 3) return;
      }
    }
  };
  visit(cwd, 0);
  return count;
}

function docsLooksLikeSkeleton(cwd: string): boolean {
  const docs = path.join(cwd, "docs");
  if (!fs.existsSync(docs)) return true;
  const entries = safeReaddir(docs).filter((entry) => !entry.name.startsWith("."));
  if (entries.length === 0) return true;
  return entries.length <= 2 && entries.every((entry) => entry.isFile() && entry.name.endsWith(".md"));
}

export class ProjectClassifier {
  static classify(cwd: string): ProjectClassification {
    const entries = safeReaddir(cwd).filter((entry) => !entry.name.startsWith(".DS_Store"));
    const names = entries.map((entry) => entry.name);
    const reasons: string[] = [];

    const manifests = names.filter((name) => MANIFEST_FILES.has(name));
    if (manifests.length > 0) {
      reasons.push(`manifest files found: ${manifests.join(", ")}`);
    }

    const sourceDirs = entries
      .filter((entry) => entry.isDirectory() && SOURCE_DIRS.has(entry.name))
      .map((entry) => entry.name);
    if (sourceDirs.length > 0) {
      reasons.push(`source directories found: ${sourceDirs.join(", ")}`);
    }

    const codeFiles = countCodeFiles(cwd);
    if (codeFiles > 0) {
      reasons.push(`${codeFiles} code file(s) found within depth 3`);
    }

    const hasHistory = hasMeaningfulGitHistory(cwd);
    if (hasHistory) {
      reasons.push("git history is present");
    }

    if (manifests.length > 0 || sourceDirs.length > 0 || codeFiles >= 3) {
      return { kind: "brownfield", confidence: "high", reasons };
    }

    const nonGreenfieldEntries = names.filter((name) => !GREENFIELD_TOP_LEVEL.has(name));
    if (nonGreenfieldEntries.length === 0 && docsLooksLikeSkeleton(cwd)) {
      return {
        kind: "greenfield",
        confidence: "high",
        reasons: reasons.length > 0 ? reasons : ["directory is empty or contains only starter docs"],
      };
    }

    if (codeFiles > 0 || hasHistory || nonGreenfieldEntries.length > 0) {
      return {
        kind: "ambiguous",
        confidence: "medium",
        reasons: reasons.length > 0
          ? reasons
          : [`non-starter files found: ${nonGreenfieldEntries.join(", ")}`],
      };
    }

    return {
      kind: "greenfield",
      confidence: "low",
      reasons: ["no manifest or source code found"],
    };
  }
}

