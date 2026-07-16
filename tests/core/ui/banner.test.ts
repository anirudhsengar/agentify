// Tests for `src/core/ui/banner.ts`.
//
// The banner is a hand-drawn ASCII block spelling AGENTIFY plus a
// version-tagged tagline. These tests pin the rendered shape so any
// accidental drift is caught at PR time — the audit logs index on
// this banner so the printed output must stay grep-stable.

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTIFY_BANNER,
  bannerLines,
  bannerTagline,
  printBanner,
} from "../../../src/core/ui/banner.ts";

test("AGENTIFY_BANNER is six rows of equal width", () => {
  const rows = AGENTIFY_BANNER.split("\n");
  assert.equal(rows.length, 6);
  const widths = new Set(rows.map((row) => row.length));
  assert.equal(widths.size, 1, `expected one banner width, got ${[...widths]}`);
});

test("AGENTIFY_BANNER references the project name visually", () => {
  const rows = AGENTIFY_BANNER.split("\n");
  // The letters AGENTIFY are formed by specific glyph positions.
  // A loose content check: every row must contain at least one of the
  // box-drawing characters we used to draw the letterforms. We don't
  // pin each cell — that would be brittle — but a banner without
  // any of those glyphs is structurally wrong.
  for (const row of rows) {
    assert.ok(
      row.includes("█") || row.includes("╗") || row.includes("╝") || row.includes("╚"),
      `every banner row should contain box-drawing glyphs, got: ${row}`,
    );
  }
});

test("bannerTagline embeds the version string", () => {
  assert.equal(bannerTagline("0.2.1"), "agentify v0.2.1  one command for the full life of an agentic codebase.");
});

test("bannerLines combines art and tagline with a single newline separator", () => {
  const output = bannerLines("0.2.1");
  const parts = output.split("\n");
  assert.equal(parts.length, AGENTIFY_BANNER.split("\n").length + 1);
  assert.equal(parts.at(-1), bannerTagline("0.2.1"));
  // The first 6 lines match the constant, line-by-line.
  const artLines = AGENTIFY_BANNER.split("\n");
  for (let i = 0; i < artLines.length; i += 1) {
    assert.equal(parts[i], artLines[i]);
  }
});

test("printBanner writes the lines + a trailing blank to the supplied stream", () => {
  const captured: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      captured.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  printBanner("0.2.1", stream);
  assert.equal(captured.length, 1);
  assert.equal(captured[0], `${bannerLines("0.2.1")}\n\n`);
});
