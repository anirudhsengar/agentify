#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

cat > "$tmp_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$1 $2 ${3:-}" in
  "issue view 42")
    printf '%s\n' '{"number":42,"body":"## Parent\n\n#7\n\n## Blocked by\n\n#8","comments":[]}'
    ;;
  "issue view 7")
    printf '%s\n' '{"number":7,"body":"parent","comments":[]}'
    ;;
  "issue view 8")
    printf '%s\n' '{"number":8,"body":"blocker","comments":[]}'
    ;;
  "pr view 9")
    printf '%s\n' '{"number":9,"closingIssuesReferences":[{"number":7}],"comments":[]}'
    ;;
  "api repos/example/project/pulls/9/reviews?per_page=100"*)
    printf '%s\n' '[{"id":1,"body":"review"}]'
    ;;
  "api repos/example/project/pulls/9/comments?per_page=100"*)
    printf '%s\n' '[{"id":2,"body":"inline"}]'
    ;;
  *)
    printf 'unexpected gh invocation: %q ' "$@" >&2
    printf '\n' >&2
    exit 1
    ;;
esac
EOF
chmod +x "$tmp_dir/gh"

PATH="$tmp_dir:$PATH" bash "$repo_root/.github/scripts/capture-issue-context.sh" \
  42 "$tmp_dir/issue-context"
jq -e '.number == 42' "$tmp_dir/issue-context/issue.json" >/dev/null
jq -e '.number == 7' "$tmp_dir/issue-context/related/7.json" >/dev/null
jq -e '.number == 8' "$tmp_dir/issue-context/related/8.json" >/dev/null

PATH="$tmp_dir:$PATH" bash "$repo_root/.github/scripts/capture-pr-context.sh" \
  9 example/project "$tmp_dir/pr-context"
jq -e '.number == 9' "$tmp_dir/pr-context/pr.json" >/dev/null
jq -e '.[0].id == 1' "$tmp_dir/pr-context/reviews.json" >/dev/null
jq -e '.[0].id == 2' "$tmp_dir/pr-context/inline-comments.json" >/dev/null
jq -e '.number == 7' "$tmp_dir/pr-context/issues/7.json" >/dev/null
