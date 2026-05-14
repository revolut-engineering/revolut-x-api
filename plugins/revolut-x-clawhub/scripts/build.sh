#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/revolut-x-clawhub"
DIST="$PLUGIN_DIR/dist"
STAGING="$DIST/staging"

rm -rf "$DIST"
mkdir -p "$STAGING"

VERSION=$(node -p "require('$PLUGIN_DIR/package.json').version")
echo "→ Building revolut-x@$VERSION clawhub bundle"

cp "$PLUGIN_DIR/package.json"          "$STAGING/"
cp "$PLUGIN_DIR/openclaw.plugin.json"  "$STAGING/"
cp "$PLUGIN_DIR/README.md"             "$STAGING/"

cp    "$REPO_ROOT/LICENSE"          "$STAGING/"
cp -R "$REPO_ROOT/.claude-plugin"   "$STAGING/"
mkdir -p "$STAGING/skills"
for d in "$REPO_ROOT"/skills/revx-*/; do
  cp -R "$d" "$STAGING/skills/$(basename "$d")"
done

( cd "$STAGING" && npm pack --silent --pack-destination "$DIST" >/dev/null )
TARBALL=$(ls "$DIST"/revolut-x-*.tgz 2>/dev/null | head -1)
[[ -n "$TARBALL" ]] || { echo "ERROR: npm pack produced no tarball" >&2; exit 1; }

SIZE=$(du -h "$TARBALL" | awk '{print $1}')
COUNT=$(tar -tzf "$TARBALL" | grep -v '/$' | wc -l | tr -d ' ')
echo
echo "✓ Bundle  : $TARBALL ($SIZE, $COUNT files)"
echo "✓ Staging : $STAGING"
echo
echo "Tarball contents:"
tar -tzf "$TARBALL" | sort | sed 's|^|    |'
echo
SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "<run from a git checkout>")

echo "── Publish manually ──"
echo
echo "  Web UI (clawhub.ai/publish-plugin) ONLY accepts code plugins, NOT Claude bundles."
echo "  The CLI is the only working path; --family bundle-plugin tells the server to skip"
echo "  code-plugin validation."
echo
echo "  Dry-run (preview, no upload):"
echo
echo "    clawhub package publish '$STAGING' \\"
echo "      --source-repo revolut-engineering/revolut-x-api \\"
echo "      --source-commit $SHA \\"
echo "      --family bundle-plugin --bundle-format claude \\"
echo "      --version $VERSION --dry-run"
echo
echo "  Real publish (drop --dry-run once the file list above looks right):"
echo
echo "    clawhub package publish '$STAGING' \\"
echo "      --source-repo revolut-engineering/revolut-x-api \\"
echo "      --source-commit $SHA \\"
echo "      --family bundle-plugin --bundle-format claude \\"
echo "      --version $VERSION"
echo
