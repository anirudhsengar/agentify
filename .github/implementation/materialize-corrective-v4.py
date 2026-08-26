#!/usr/bin/env python3
from pathlib import Path
import subprocess

subprocess.run(["python", ".github/implementation/materialize-corrective-v3.py"], check=True)

target = Path("tests/release-safety.test.ts")
text = target.read_text()
old = '  assert.equal(scripts["verify:source"], "npm run typecheck && npm run test:all");\n'
new = '''  assert.equal(
    scripts["verify:source"],
    "npm run verify:repository-clean && npm run typecheck && npm run test:all",
  );
  assert.equal(
    scripts["verify:repository-clean"],
    "node scripts/verify-implementation-diff.mjs",
  );
'''
if text.count(old) != 1:
    raise SystemExit(f"release contract update: expected one match, found {text.count(old)}")
target.write_text(text.replace(old, new, 1))
print("release verification contract updated")
