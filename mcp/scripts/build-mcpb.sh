#!/usr/bin/env bash
# Build the MCPB Desktop Extension archive.
# Usage: ./scripts/build-mcpb.sh
# Produces: dist/revolutx-mcp.mcpb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_DIR="$MCP_DIR/packaging/mcpb/stage"

cd "$MCP_DIR"

# 1. Build the esbuild bundle
echo ">> Building bundle..."
npm run build:bundle

# 2. Prepare stage directory
echo ">> Preparing stage directory..."
MCPB_DIR="$MCP_DIR/packaging/mcpb"
mkdir -p "$STAGE_DIR/dist"
cp dist/index.js "$STAGE_DIR/dist/index.js"
cp "$MCPB_DIR/manifest.json" "$STAGE_DIR/manifest.json"
cp "$MCPB_DIR/.mcpbignore" "$STAGE_DIR/.mcpbignore"
cp "$MCP_DIR/package.json" "$STAGE_DIR/package.json"

# 3. Pack with mcpb
echo ">> Packing MCPB archive..."
cd "$STAGE_DIR"
npx --yes @anthropic-ai/mcpb pack

# 4. Move the produced .mcpb file to mcp/dist/
MCPB_FILE=$(ls -1 *.mcpb 2>/dev/null | head -1)
if [ -z "$MCPB_FILE" ]; then
  echo "ERROR: mcpb pack did not produce a .mcpb file" >&2
  exit 1
fi

mv "$MCPB_FILE" "$MCP_DIR/dist/revolutx-mcp.mcpb"
echo ">> Done: dist/revolutx-mcp.mcpb"
