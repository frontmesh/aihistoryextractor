#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION="$ROOT/extension"
DIST="$ROOT/dist"
VERSION="$(node -p "require('$EXTENSION/manifest.json').version")"
OUT="$DIST/deepseek-chat-exporter-$VERSION.zip"

mkdir -p "$DIST"
rm -f "$OUT"

# Validate the manifest before shipping it.
node -e "const m=require('$EXTENSION/manifest.json'); if(m.manifest_version!==3) throw new Error('manifest_version must be 3'); if(!m.background||!m.background.service_worker) throw new Error('missing service worker'); console.log('manifest ok:', m.name, m.version)"

cd "$EXTENSION"
zip -qr "$OUT" . -x '*.DS_Store' '*.map'

echo "Built $OUT"
unzip -l "$OUT" | tail -n 4
