#!/usr/bin/env bash
# Build the MCPB Desktop Extension archive.
# Usage: ./scripts/build-mcpb.sh
# Produces: dist/revolutx-mcp.mcpb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_DIR="$MCP_DIR/packaging/mcpb/stage"

cd "$MCP_DIR"

if [ ! -f "../api/dist/index.js" ]; then
  echo ">> Building API (required for bundle)..."
  (cd ../api && npm run build)
fi

echo ">> Building bundle..."
npm run build:bundle

echo ">> Copying bundle to stage..."
mkdir -p "$STAGE_DIR/dist"
cp dist/index.js "$STAGE_DIR/dist/index.js"
MCPB_DIR="$MCP_DIR/packaging/mcpb"
cp "$MCPB_DIR/manifest.json" "$STAGE_DIR/manifest.json"
[ -f "$MCPB_DIR/.mcpbignore" ] && cp "$MCPB_DIR/.mcpbignore" "$STAGE_DIR/.mcpbignore"
cp "$MCP_DIR/package.json" "$STAGE_DIR/package.json"
[ -f "$MCP_DIR/icon.png" ] && cp "$MCP_DIR/icon.png" "$STAGE_DIR/icon.png"
cp "$MCP_DIR/README.md" "$STAGE_DIR/README.md"
cp "$MCP_DIR/../LICENSE" "$STAGE_DIR/LICENSE"

echo ">> Packing MCPB archive..."
cd "$STAGE_DIR"
npx @anthropic-ai/mcpb pack

MCPB_FILE=$(ls -1 *.mcpb 2>/dev/null | head -1)
if [ -z "$MCPB_FILE" ]; then
  echo "ERROR: mcpb pack did not produce a .mcpb file" >&2
  exit 1
fi

mv "$MCPB_FILE" "$MCP_DIR/dist/revolutx-mcp.mcpb"
echo ">> Done: dist/revolutx-mcp.mcpb"
