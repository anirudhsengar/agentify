import { AGENTIFY_MANAGED_MARKERS, addMarkdownManagedMarker } from "../managed-markers.ts";
import { normalizeArtifactPath } from "../generated-surface.ts";
import type { ManagedArtifactKind, RenderedArtifact } from "./types.ts";

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROMPT_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export const REQUIRED_ALWAYS_ON_DOCS = new Set(["specs/README.md", "ai_docs/README.md"]);

export function isSafeRelativePath(relativePath: string): boolean {
  const normalized = normalizeArtifactPath(relativePath);
  return normalized.length > 0
    && SAFE_RELATIVE_PATH.test(normalized)
    && !normalized.split("/").some((part) => part === "" || part === ".");
}

export function isKebabName(name: string): boolean {
  return KEBAB_NAME.test(name);
}

export function isPromptName(name: string): boolean {
  return PROMPT_NAME.test(name);
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split("\n").length;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function markdownArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  return {
    relativePath: normalizeArtifactPath(params.relativePath),
    content: ensureTrailingNewline(addMarkdownManagedMarker(params.body)),
    marker: AGENTIFY_MANAGED_MARKERS.markdown,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

export function hashCommentArtifact(params: {
  relativePath: string;
  body: string;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  const marker = AGENTIFY_MANAGED_MARKERS.toml;
  const body = params.body.includes(marker) ? params.body : `${marker}\n${params.body}`;
  return {
    relativePath: normalizeArtifactPath(params.relativePath),
    content: ensureTrailingNewline(body),
    marker,
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

export function jsonArtifact(params: {
  relativePath: string;
  value: unknown;
  kind: ManagedArtifactKind;
  required: boolean;
  source: string;
}): RenderedArtifact {
  return {
    relativePath: normalizeArtifactPath(params.relativePath),
    content: ensureTrailingNewline(JSON.stringify(params.value, null, 2)),
    marker: "sha256",
    kind: params.kind,
    required: params.required,
    source: params.source,
  };
}

export function yamlScalar(value: string): string {
  return JSON.stringify(oneLine(value));
}

export function yamlStringArray(key: string, values: string[], indent = 0): string[] {
  const prefix = " ".repeat(indent);
  if (values.length === 0) return [`${prefix}${key}: []`];
  return [
    `${prefix}${key}:`,
    ...values.map((value) => `${prefix}  - ${yamlScalar(value)}`),
  ];
}

export function titleCaseName(value: string): string {
  return value
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
