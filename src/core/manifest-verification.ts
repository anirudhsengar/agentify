import * as fs from "node:fs";
import * as path from "node:path";
import {
  manifestPathFor,
  readManifestAt,
  sha256,
  type ManagedManifest,
  type ManifestVerification,
} from "./manifest.ts";

function fileCarriesMarker(content: string, marker: string): boolean {
  return marker === "sha256" || content.includes(marker);
}

/** Verify the manifest stored in an explicitly resolved state directory. */
export function verifyManifestAt(cwd: string, stateDir: string): ManifestVerification {
  const manifest = readManifestAt(cwd, stateDir);
  if (!manifest) {
    return {
      manifest: null,
      valid: false,
      mode: "unknown",
      found: [],
      missing: [],
      mismatched: [],
      unmanaged: [],
    };
  }

  const found: string[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  const unmanaged: string[] = [];

  if (manifest.state_dir !== undefined && manifest.state_dir !== stateDir) {
    mismatched.push(
      `manifest.json (state_dir=${manifest.state_dir}, expected ${stateDir})`,
    );
  }

  for (const file of manifest.files) {
    if (!file.required || file.alongsidePath) continue;
    const filePath = path.join(cwd, file.path);
    if (!fs.existsSync(filePath)) {
      missing.push(file.path);
      continue;
    }
    const content = fs.readFileSync(filePath);
    const text = content.toString("utf-8");
    found.push(file.path);
    if (!fileCarriesMarker(text, file.marker)) {
      unmanaged.push(file.path);
      continue;
    }
    if (sha256(content) !== file.sha256) {
      mismatched.push(file.path);
    }
  }

  return {
    manifest,
    valid: missing.length === 0 && mismatched.length === 0 && unmanaged.length === 0,
    mode: manifest.mode,
    found,
    missing,
    mismatched,
    unmanaged,
  };
}

/**
 * Write a manifest to one physical state directory while independently
 * controlling the recorded provider state directory. A null recorded path
 * preserves pre-provider-scoping legacy semantics during Phase A.
 */
export function writeManifestWithStateRecord(
  cwd: string,
  manifest: ManagedManifest,
  physicalStateDir: string,
  recordedStateDir: string | null,
): void {
  const stamped: ManagedManifest = recordedStateDir === null
    ? { ...manifest, state_dir: undefined }
    : { ...manifest, state_dir: recordedStateDir };
  const filePath = manifestPathFor(cwd, physicalStateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stamped, null, 2)}\n`, { mode: 0o644 });
}
