#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
if git config --get core.hooksPath >/dev/null; then
  printf 'An existing core.hooksPath is configured; invoke .githooks/pre-commit from that hook.\n' >&2
  exit 1
fi
hooks=$(git rev-parse --git-path hooks)
if [[ -e "$hooks/pre-commit" ]] && ! grep -Fq '# herdr-web managed pre-commit' "$hooks/pre-commit"; then
  printf 'An existing pre-commit hook is present; integrate .githooks/pre-commit into it.\n' >&2
  exit 1
fi
mkdir -p "$hooks"
install -m 755 "$root/.githooks/pre-commit" "$hooks/pre-commit"
printf 'Installed pre-commit: formatting, compiler/lint checks, and unit tests.\n'
