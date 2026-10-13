#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for built in api/dist/index.js cli/dist/bin/revx.js; do
  if [[ ! -f "$REPO_ROOT/$built" ]]; then
    echo "ERROR: $built is missing. Run 'npm run build' first." >&2
    exit 1
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(cd "$REPO_ROOT/api" && npm pack --pack-destination "$WORK" >/dev/null)
(cd "$REPO_ROOT/cli" && npm pack --pack-destination "$WORK" >/dev/null)

cd "$WORK"
npm init -y >/dev/null
npm install --loglevel=error --no-audit --no-fund ./revolut-revolut-x-api-*.tgz ./revolut-revolut-x-cli-*.tgz >/dev/null

if [[ -d node_modules/@revolut/revolut-x-cli/node_modules/@revolut/revolut-x-api ]]; then
  echo "ERROR: the packed CLI did not accept the packed api and installed its own copy." >&2
  exit 1
fi

./node_modules/.bin/revx --version
./node_modules/.bin/revx --help >/dev/null
echo "OK: the packed CLI installs and starts with the packed api"
