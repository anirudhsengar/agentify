import { createHash } from "node:crypto";
import {
  CodebaseMapSchema,
  PartialCodebaseMapSchema,
  WriteMapDeltaParamsSchema,
  WriteMapParamsSchema,
} from "../../src/core/audit/schema.ts";

for (const [name, schema] of Object.entries({
  codebase_map: CodebaseMapSchema,
  partial_codebase_map: PartialCodebaseMapSchema,
  write_map_params: WriteMapParamsSchema,
  write_map_delta_params: WriteMapDeltaParamsSchema,
})) {
  const serialized = JSON.stringify(schema);
  console.log(`${name} ${createHash("sha256").update(serialized).digest("hex")} ${Buffer.byteLength(serialized)}`);
}
