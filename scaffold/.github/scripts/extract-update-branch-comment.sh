#!/usr/bin/env bash
set -euo pipefail

transcript=${1:-}
comment_file=${2:-}

if [ -z "$transcript" ] || [ -z "$comment_file" ]; then
  echo "usage: extract-update-branch-comment.sh <transcript> <comment-file>" >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

bash "$script_dir/extract-output.sh" "$transcript" > "$tmp"
jq -e 'type == "object" and (.comment | type == "string" and length > 0)' "$tmp" >/dev/null
jq -r '.comment' "$tmp" > "$comment_file"
