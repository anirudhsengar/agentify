import * as fs from "node:fs";
import * as path from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Open a path without following its final symlink and read through the same
 * descriptor that was verified as a bounded regular file. This avoids the
 * check/use race created by lstat(path) followed by readFile(path).
 */
export function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
): Buffer | null {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("maximum regular-file read size must be a non-negative safe integer");
  }

  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) return null;

    // Windows does not expose O_NOFOLLOW with POSIX semantics. Reject a final
    // reparse-point/symlink by requiring the opened path to resolve to itself.
    if (
      process.platform === "win32"
      && path.normalize(fs.realpathSync.native(filePath)).toLowerCase()
        !== path.resolve(filePath).toLowerCase()
    ) {
      return null;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes + 1 - totalBytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
