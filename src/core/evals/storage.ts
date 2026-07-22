import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export function validateEvalValue<T>(schema: TSchema, value: unknown, label: string): T {
  if (!Value.Check(schema, value)) {
    const detail = [...Value.Errors(schema, value)].slice(0, 8).map((error) => {
      const located = error as { path?: string; instancePath?: string; message: string };
      return `${located.path ?? located.instancePath ?? "(root)"}: ${located.message}`;
    }).join("; ");
    throw new Error(`${label} failed schema validation: ${detail}`);
  }
  return value as T;
}
export function readValidatedJson<T>(filePath: string, schema: TSchema, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { throw new Error(`corrupt ${label} at ${filePath}`, { cause: error }); }
  return validateEvalValue<T>(schema, parsed, label);
}
export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
export function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { const descriptor = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); fs.closeSync(descriptor); fs.renameSync(temporary, filePath); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* cleanup */ } throw new Error(`failed to persist ${filePath}`, { cause: error }); }
}
export function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(value)}\n`;
  const descriptor = fs.openSync(filePath, "a", 0o600);
  try { fs.writeSync(descriptor, line, undefined, "utf8"); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
export function readJsonLines<T>(filePath: string, schema: TSchema, label: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  if (content !== "" && !content.endsWith("\n")) throw new Error(`corrupt ${label}: incomplete JSONL append`);
  return content.split("\n").filter(Boolean).map((line, index) => {
    try { return validateEvalValue<T>(schema, JSON.parse(line), `${label} line ${index + 1}`); }
    catch (error) { throw new Error(`corrupt ${label} line ${index + 1}`, { cause: error }); }
  });
}
