# 012 — Docs and package alignment

## Goal

Ensure the npm package, README, stamped SETUP, and target-repo docs all
reference files that actually exist for the reader.

## Evidence

- README links to `docs/lifecycle/README.md`, but `package.json#files`
  excludes `docs` and `npm pack --dry-run` does not include docs.
- `scaffold/SETUP.md` links to `docs/adr/...`, but target repos receive
  `SETUP.md`, not agentify's docs tree.
- README's "What Gets Written" table omits several builder-prompt outputs
  such as `app_review/`, `app_docs/`, `.pi/prompts/experts/`, `.pi/extensions/`.

## Scope

Docs, package metadata, scaffold setup text, and documentation tests.

## Implementation plan

1. Decide whether npm publishes `docs/` or README stops linking to
   unpublished docs. Prefer publishing docs if package size remains sane.
2. Rewrite stamped `SETUP.md` links so they are self-contained or point to
   public URLs, not target-local missing ADRs.
3. Update README's generated-file table after issues 006/007 settle the
   deterministic generated surface.
4. Add a link-check contract test for README and scaffold docs.
5. Document conflict recovery, partial run recovery, and how to inspect logs.

## Acceptance criteria

- Every README link works in the npm package context.
- Every stamped SETUP link works in the target repo context.
- `npm pack --dry-run` output is checked by a test or documented release
  checklist.

## Validation

```bash
npm pack --dry-run
bash tests/run.sh
```
