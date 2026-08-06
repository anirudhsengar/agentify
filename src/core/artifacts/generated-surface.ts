/** Normalize repository-relative artifact paths without resolving them. */
export function normalizeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}
