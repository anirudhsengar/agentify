import { spawnSync } from "node:child_process";
import { sanitizedTaskEnvironment } from "./validation-runner.ts";
import { TaskLifecycleError } from "./state-machine.ts";

function gitNul(root: string, args: string[]): string[] {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    env: sanitizedTaskEnvironment(process.env),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new TaskLifecycleError("invalid_input", `trusted path inventory failed for git ${args[0]}`);
  }
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  return output.split("\0").filter(Boolean);
}

export function diffPathInventory(root: string, range: string): string[] {
  const entries = gitNul(root, [
    "diff", "--name-status", "-z", "--find-renames", "--find-copies", "--find-copies-harder",
    "--diff-filter=ACDMRTUXB", range, "--",
  ]);
  const paths: string[] = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    if (!status) throw new TaskLifecycleError("invalid_input", "git path inventory contains an empty status");
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const previous = entries[index++];
      const current = entries[index++];
      if (!previous || !current) throw new TaskLifecycleError("invalid_input", "git rename or copy inventory is malformed");
      paths.push(previous, current);
    } else {
      const current = entries[index++];
      if (!current) throw new TaskLifecycleError("invalid_input", "git path inventory is malformed");
      paths.push(current);
    }
  }
  return [...new Set(paths)].sort();
}
