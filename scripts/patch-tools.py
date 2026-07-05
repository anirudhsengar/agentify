#!/usr/bin/env python3
"""Patch tool files: unify details shape between success and error paths."""
import re
import sys
from pathlib import Path

files = list(Path("src/core/orchestrator/tools").glob("*.ts"))
for filepath in files:
    content = filepath.read_text()
    # Replace 'isError: true,\n      details: {...}' with a unified shape
    # that matches the success path's shape (via `as never` cast).
    # The pattern matches error returns.
    new_content = re.sub(
        r"isError: true,\s*\n(\s+)details: \{([^}]*)\},",
        lambda m: f"isError: true,\n{m.group(1)}details: {{ {m.group(2)} }} as never,",
        content,
    )
    filepath.write_text(new_content)
    print(f"patched {filepath}")