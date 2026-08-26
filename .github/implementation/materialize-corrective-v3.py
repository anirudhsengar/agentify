#!/usr/bin/env python3
from pathlib import Path
import subprocess

subprocess.run(["python", ".github/implementation/materialize-corrective-v2.py"], check=True)

target = Path("src/core/audit/specialist-completion.ts")
text = target.read_text()
old = '''  const attachments = inferRepositoryConcernAttachments({
    map,
    accepted,
    clusters: repositoryClusters,
    structuralHighSignal,
  });
'''
new = '''  // Inferred attachments depend on an exact tracked repository tree. Without
  // one (for example schema-only callers and degraded non-Git fixtures), only
  // explicit concern evidence may satisfy semantic closure. This prevents
  // filename or directory heuristics from silently absorbing distinct public
  // surfaces such as help rendering or type declarations.
  const attachments = repository.trackedFiles === undefined
    ? []
    : inferRepositoryConcernAttachments({
      map,
      accepted,
      clusters: repositoryClusters,
      structuralHighSignal,
    });
'''
if text.count(old) != 1:
    raise SystemExit(f"tracked-tree attachment gate: expected one match, found {text.count(old)}")
target.write_text(text.replace(old, new, 1))
print("tracked-tree attachment gate applied")
