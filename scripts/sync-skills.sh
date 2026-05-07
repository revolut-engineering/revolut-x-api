#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/plugins/revolut-x/skills"
DST="$REPO_ROOT/skills"

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: $SRC does not exist" >&2
  exit 1
fi

case "${1:-sync}" in
  check)
    if diff -r "$SRC" "$DST" >/dev/null 2>&1; then
      echo "OK: skills trees are in sync"
      exit 0
    fi
    echo "DRIFT detected between $SRC and $DST:" >&2
    diff -r "$SRC" "$DST" >&2 || true
    echo >&2
    echo "Run 'npm run sync-skills' to mirror the plugin copy back to repo-root /skills/." >&2
    exit 1
    ;;
  sync)
    rsync -a --delete "$SRC/" "$DST/"
    echo "Synced $SRC/ -> $DST/"
    ;;
  *)
    echo "usage: $0 [sync|check]" >&2
    exit 2
    ;;
esac
