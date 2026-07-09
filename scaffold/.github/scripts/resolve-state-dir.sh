#!/usr/bin/env bash
# Resolve the agentify state dir for a target repo.
#
# Usage:
#   resolve-state-dir.sh <repo_root>
#
# Prints the posix-style relative path of the agentify state dir
# for the supplied repository. Reads the canonical `.pi/agentify/`,
# `.agents/agentify/`, or `.claude/agentify/` `manifest.json` and
# honors the `state_dir` field it records. When the new-style
# manifest is missing, falls back to inspecting the filesystem for
# which state dir contains the manifest; if no manifest exists,
# defaults to `.pi/agentify/` for backward compatibility.
#
# The output is intended for use by other scaffold scripts:
#
#   state_dir=$(./resolve-state-dir.sh "$repo_root")
#   state_file="$repo_root/$state_dir/$file_name"

set -euo pipefail

repo_root=${1:?"repo_root required"}

# Candidate state-dir roots, in priority order: codex → claude → pi.
# (Universal-agent `additionalAgents` resolve to `.agents/agentify/`
# at audit time, which the first entry already covers.)
candidate_bases=(
  ".agents/agentify"
  ".claude/agentify"
  ".pi/agentify"
)

for base in "${candidate_bases[@]}"; do
  manifest="$repo_root/$base/manifest.json"
  if [ -f "$manifest" ]; then
    if command -v jq >/dev/null 2>&1; then
      recorded=$(jq -r '.state_dir // empty' "$manifest" 2>/dev/null || true)
      if [ -n "$recorded" ] && [ "$recorded" != "null" ]; then
        printf '%s\n' "$recorded"
        exit 0
      fi
    fi
    # Manifest has no `state_dir` field yet — assume the dir the
    # manifest lives in is the right state dir (legacy `.pi/agentify`
    # repos with new code that hasn't been re-written keep working).
    printf '%s\n' "$base"
    exit 0
  fi
done

# Default fallback when no manifest is present. Matches the
# legacy-pi default so existing repos that just got their first
# audit land in the historical location.
printf '%s\n' ".pi/agentify"
