import * as fs from "node:fs";

const file = "src/core/audit/defense-hook.ts";
let source = fs.readFileSync(file, "utf-8");

const oldHelper = `function isInsideAny(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(target, realResolve(path.resolve(root))));
}`;
const newHelper = `function isWithinPolicyRoots(
  absolute: string,
  real: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => {
    const lexicalRoot = path.resolve(root);
    const realRoot = realResolve(lexicalRoot);
    return isInside(absolute, lexicalRoot) && isInside(real, realRoot);
  });
}`;
if (!source.includes(oldHelper)) throw new Error("policy root helper marker not found");
source = source.replace(oldHelper, newHelper);

const oldCheck = `          if (!isInsideAny(real, roots) && !isInsideAny(absolute, roots)) {`;
const newCheck = `          if (!isWithinPolicyRoots(absolute, real, roots)) {`;
if (!source.includes(oldCheck)) throw new Error("policy root check marker not found");
source = source.replace(oldCheck, newCheck);

fs.writeFileSync(file, source);
console.log("policy root containment fixed");
