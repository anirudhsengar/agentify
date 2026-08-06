import * as path from "node:path";

/**
 * Compute a sibling path for Agentify-managed content without touching the
 * user's canonical file.
 */
export function alongsidePathFor(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const ext = path.extname(normalized);
  const base = path.basename(normalized, ext);
  const dir = path.dirname(normalized);
  const newBase = ext ? `${base}.agentify${ext}` : `${base}.agentify`;
  return dir === "." || dir === "" ? newBase : `${dir}/${newBase}`;
}
