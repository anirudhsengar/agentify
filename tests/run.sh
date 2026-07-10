#!/usr/bin/env bash
# agentify's own contract tests — validate that the unified repo hangs together.
# (The tests stamped into a *target* repo live in scaffold/tests/.)
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

for test_file in "$repo_root"/tests/test-*.sh; do
  echo "==> $(basename "$test_file")"
  bash "$test_file"
done
