import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function isAgentifyPackageRoot(candidate: string): boolean {
  const packageJsonPath = path.join(candidate, "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return parsed.name === "agentify";
  } catch {
    return false;
  }
}

export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
  let current = path.dirname(fileURLToPath(fromUrl));
  while (true) {
    if (isAgentifyPackageRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not resolve the agentify package root from ${fromUrl}`);
    }
    current = parent;
  }
}
