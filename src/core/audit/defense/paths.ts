// Path-parameter name coverage (Phase 2.5).
// Per-tool list of parameter names that carry a filesystem path.
// The defense hook uses this to extract the path from tool input,
// regardless of which name the LLM happened to use.

export const PATH_PARAM_NAMES: Record<string, ReadonlyArray<string>> = {
  read: ["path", "filePath", "file_path", "target", "filepath", "filename", "file"],
  write: [
    "path",
    "filePath",
    "file_path",
    "target",
    "filepath",
    "filename",
    "file",
    "outputPath",
    "output_path",
    "destination",
  ],
  edit: [
    "path",
    "filePath",
    "file_path",
    "target",
    "filepath",
    "filename",
    "file",
  ],
  write_file: [
    "path",
    "filePath",
    "file_path",
    "target",
    "filepath",
    "filename",
    "file",
    "outputPath",
    "output_path",
    "destination",
  ],
  multi_edit: [
    "path",
    "filePath",
    "file_path",
    "target",
    "filepath",
    "filename",
    "file",
  ],
};

/** Return the first path-bearing string from `input`, or empty. */
export function extractPathFromInputForTool(
  toolName: string,
  input: unknown,
): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const names = PATH_PARAM_NAMES[toolName] ?? ["path"];
  for (const name of names) {
    const v = i[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
