#!/usr/bin/env bash
# リポジトリのルートからライブラリをビルドする。
set -euo pipefail
cd "$(dirname "$0")/webtcp_jslib"
npm install
npm run build
echo "built: webtcp_jslib/dist/index.js"
