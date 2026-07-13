#!/usr/bin/env bash
# Resolve one authoritative Agentify state directory from repository manifests.
# Canonical manifests must record their own state_dir. A single legacy manifest
# without state_dir remains readable as upgrade input. Multiple unstamped trees
# are ambiguous and fail instead of applying an independent precedence rule.

set -euo pipefail
repo_root=${1:?'repo_root required'}

candidate_bases=(
  ".agents/agentify"
  ".claude/agentify"
  ".pi/agentify"
)

manifests=()
explicit=()
legacy_unstamped=()
for base in "${candidate_bases[@]}"; do
  manifest="$repo_root/$base/manifest.json"
  [ -f "$manifest" ] || continue
  manifests+=("$base")
  recorded=$(node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (value && typeof value.state_dir === "string") process.stdout.write(value.state_dir);
    } catch { process.exit(2); }
  ' "$manifest") || {
    printf 'agentify: invalid manifest at %s; state directory cannot be resolved safely\n' "$base/manifest.json" >&2
    exit 1
  }
  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$base" ]; then
      printf 'agentify: manifest state_dir mismatch at %s: recorded %s; no fallback was attempted\n' "$base/manifest.json" "$recorded" >&2
      exit 1
    fi
    explicit+=("$base")
  else
    legacy_unstamped+=("$base")
  fi
done

if [ "${#explicit[@]}" -eq 1 ]; then
  printf '%s\n' "${explicit[0]}"
  exit 0
fi
if [ "${#explicit[@]}" -gt 1 ]; then
  printf 'agentify: multiple explicit state manifests found: %s; resolve the provider conflict before continuing\n' "${explicit[*]}" >&2
  exit 1
fi
if [ "${#legacy_unstamped[@]}" -eq 1 ]; then
  printf '%s\n' "${legacy_unstamped[0]}"
  exit 0
fi
if [ "${#legacy_unstamped[@]}" -gt 1 ]; then
  printf 'agentify: multiple unstamped state manifests found: %s; run agentify with the owning provider to complete migration\n' "${legacy_unstamped[*]}" >&2
  exit 1
fi

printf 'agentify: no Agentify manifest found; run agentify before invoking scaffold state tooling\n' >&2
exit 1
