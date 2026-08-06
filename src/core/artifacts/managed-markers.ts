import { normalizeArtifactPath } from "./generated-surface.ts";

export const MARKDOWN_MANAGED_MARKER = "<!-- agentify:managed -->";
export const TOML_MANAGED_MARKER = "# agentify:managed";
export const SLASH_MANAGED_MARKER = "// agentify:managed";
export const SHA256_MANAGED_MARKER = "sha256";

export const AGENTIFY_MANAGED_MARKERS = {
  markdown: MARKDOWN_MANAGED_MARKER,
  toml: TOML_MANAGED_MARKER,
  slash: SLASH_MANAGED_MARKER,
} as const;

/** Insert the managed marker after YAML frontmatter when present. */
export function addMarkdownManagedMarker(raw: string): string {
  if (raw.includes(MARKDOWN_MANAGED_MARKER)) return raw;
  const frontmatter = raw.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  if (!frontmatter) return `${MARKDOWN_MANAGED_MARKER}\n${raw}`;
  return `${frontmatter[1]}${MARKDOWN_MANAGED_MARKER}\n${frontmatter[2]}`;
}

function addCommentManagedMarker(raw: string, marker: string): string {
  if (raw.includes(marker)) return raw;

  const shebang = raw.match(/^#![^\r\n]*(\r\n|\n|\r)/);
  if (shebang) {
    const lineBreak = shebang[1]!;
    return `${shebang[0]}${marker}${lineBreak}${raw.slice(shebang[0].length)}`;
  }

  if (raw.startsWith("#!")) {
    return `${raw}\n${marker}\n`;
  }

  const lineBreak = raw.includes("\r\n") ? "\r\n" : raw.includes("\r") ? "\r" : "\n";
  return `${marker}${lineBreak}${raw}`;
}

/** Insert the hash-comment marker after a shebang when present. */
export function addHashCommentManagedMarker(raw: string): string {
  return addCommentManagedMarker(raw, TOML_MANAGED_MARKER);
}

/** Insert the slash-comment marker after a shebang when present. */
export function addSlashCommentManagedMarker(raw: string): string {
  return addCommentManagedMarker(raw, SLASH_MANAGED_MARKER);
}

export function addManagedMarker(raw: string, marker: string): string {
  if (marker === MARKDOWN_MANAGED_MARKER) return addMarkdownManagedMarker(raw);
  if (marker === TOML_MANAGED_MARKER) return addHashCommentManagedMarker(raw);
  if (marker === SLASH_MANAGED_MARKER) return addSlashCommentManagedMarker(raw);
  return raw.includes(marker) ? raw : `${marker}\n${raw}`;
}

export function markerForArtifactPath(relativePath: string): string {
  const normalized = normalizeArtifactPath(relativePath);
  if (normalized.endsWith(".md")) return MARKDOWN_MANAGED_MARKER;
  if (normalized.endsWith(".json")) return SHA256_MANAGED_MARKER;
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs") || normalized.endsWith(".ts")) {
    return SLASH_MANAGED_MARKER;
  }
  return TOML_MANAGED_MARKER;
}
