// Filesystem path parameters accepted by each built-in tool.
// The defense hook uses this table to apply root and zero-access checks
// regardless of which supported alias the runtime emits.

const READ_PATH_NAMES = [
  "path",
  "filePath",
  "file_path",
  "target",
  "filepath",
  "filename",
  "file",
] as const;

export const PATH_PARAM_NAMES: Record<string, ReadonlyArray<string>> = {
  read: READ_PATH_NAMES,
  grep: ["path", "directory", "dir", "cwd", "root"],
  find: ["path", "directory", "dir", "cwd", "root"],
  ls: ["path", "directory", "dir", "cwd", "root"],
  write: [
    ...READ_PATH_NAMES,
    "outputPath",
    "output_path",
    "destination",
  ],
  edit: READ_PATH_NAMES,
  write_file: [
    ...READ_PATH_NAMES,
    "outputPath",
    "output_path",
    "destination",
  ],
  multi_edit: READ_PATH_NAMES,
};

/** Return the first path-bearing string from `input`, or empty. */
export function extractPathFromInputForTool(
  toolName: string,
  input: unknown,
): string {
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  const names = PATH_PARAM_NAMES[toolName] ?? ["path"];
  for (const name of names) {
    const value = values[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}
