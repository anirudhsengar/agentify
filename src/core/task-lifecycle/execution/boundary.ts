import { pathWithinTaskScope } from "../serialization.ts";

export interface BoundaryAssessment {
  passed: boolean;
  reasons: string[];
}

export function fileInsideAnyTaskScope(file: string, scopes: ReadonlyArray<string>): boolean {
  return scopes.some((scope) => pathWithinTaskScope(file, scope));
}
