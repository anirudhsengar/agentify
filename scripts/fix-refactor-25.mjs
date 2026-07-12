import * as fs from "node:fs";
import * as path from "node:path";

const filePath = path.join(process.cwd(), "src/core/revert.ts");
let source = fs.readFileSync(filePath, "utf8");
source = source.replace(
  "snapshot: AuditArtifactSnapshot;",
  'snapshot: AuditArtifactSnapshot | Record<string, { content: Buffer; mode: number; ownership: "managed" | "unmanaged" }>;',
);
source = source.replace(
  "for (const [rel, entry] of params.snapshot) {",
  "const snapshotEntries = params.snapshot instanceof Map\n" +
    "    ? params.snapshot.entries()\n" +
    "    : Object.entries(params.snapshot);\n" +
    "  for (const [rel, entry] of snapshotEntries) {",
);
fs.writeFileSync(filePath, source);
console.log("Issue #25 compatibility adapters applied.");
