#!/usr/bin/env bash
# Fails if a client build or source carries the geo provider's secrets
# (ADR 044): the Barikoi key lives only in apps/api's environment, and only
# apps/api ever calls Barikoi — so no web, admin or mobile file may contain
#
#   - Barikoi's API host        barikoi.xyz
#   - anything shaped like a key   bkoi_ followed by 20+ letters/digits
#   - the actual key value      $BARIKOI_API_KEY, when the environment has it
#
# Usage: scripts/ci/check-geo-secrets.sh DIR [DIR...]
#   CI: after `pnpm build`  -> apps/web/.next apps/admin/.next apps/web/public
#       Flutter job         -> apps/mobile/lib apps/mobile/assets
# A missing directory is reported and skipped (e.g. a build that didn't run);
# exit status 1 means a leak was found, and every offending file is listed.
# Self-test: scripts/ci/check-geo-secrets.test.sh.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 DIR [DIR...]" >&2
  exit 2
fi

HOST_PATTERN='barikoi\.xyz'
KEY_PATTERN='bkoi_[A-Za-z0-9]{20,}'
leaks=0

for dir in "$@"; do
  if [ ! -e "$dir" ]; then
    echo "check-geo-secrets: skipping $dir (not found)"
    continue
  fi
  # -I: text files only; .next/cache holds Next's own fetch cache, not shipped code.
  found="$(grep -rIlE --exclude-dir=node_modules --exclude-dir=cache \
    -e "$HOST_PATTERN" -e "$KEY_PATTERN" -- "$dir" || true)"
  if [ -n "${BARIKOI_API_KEY:-}" ]; then
    found="$found"$'\n'"$(grep -rIlF --exclude-dir=node_modules --exclude-dir=cache \
      -e "$BARIKOI_API_KEY" -- "$dir" || true)"
  fi
  found="$(printf '%s\n' "$found" | sed '/^$/d' | sort -u)"
  if [ -n "$found" ]; then
    echo "check-geo-secrets: Barikoi host or key found in $dir:" >&2
    printf '  %s\n' $found >&2
    leaks=1
  fi
done

if [ "$leaks" -ne 0 ]; then
  echo "check-geo-secrets: FAILED — only apps/api may know Barikoi (ADR 044)." >&2
  exit 1
fi
echo "check-geo-secrets: clean ($*)"
