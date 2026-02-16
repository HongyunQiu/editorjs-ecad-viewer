#!/usr/bin/env bash
set -euo pipefail

echo "开始构建（ecad-viewer + editorjs-ecad-viewer）并复制产物..."
npm run build:all
echo "完成。"
