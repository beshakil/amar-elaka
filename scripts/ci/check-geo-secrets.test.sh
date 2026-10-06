#!/usr/bin/env bash
# Self-test for check-geo-secrets.sh: a clean tree passes; a planted host, a
# planted key-shaped string, or the planted real key value each fail it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$here/check-geo-secrets.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

expect() {
  local want="$1" name="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected $want, got $got"
    failures=1
  fi
}

mkdir -p "$tmp/clean/static" "$tmp/host" "$tmp/key" "$tmp/real"
# The attribution text names Barikoi; that is allowed — only the host and keys are not.
echo 'export const credit = "ঠিকানার তথ্য: Barikoi";' >"$tmp/clean/static/app.js"
echo 'fetch("https://barikoi.xyz/v2/api/search")' >"$tmp/host/chunk.js"
echo 'const k = "bkoi_0123456789abcdef0123456789abcdef";' >"$tmp/key/main.dart"
echo 'const k = "plantedkeyvalue42";' >"$tmp/real/env.js"

expect pass 'a clean build passes' "$check" "$tmp/clean"
expect fail 'a planted Barikoi host fails' "$check" "$tmp/clean" "$tmp/host"
expect fail 'a planted key-shaped string fails' "$check" "$tmp/key"
expect fail 'the planted real key value fails' env BARIKOI_API_KEY=plantedkeyvalue42 "$check" "$tmp/real"
expect pass 'a missing directory is skipped' "$check" "$tmp/does-not-exist" "$tmp/clean"

exit "$failures"
