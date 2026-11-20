#!/usr/bin/env bash
set -euo pipefail
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
erlc -Werror -o "$output" src/*.erl test/*.erl
