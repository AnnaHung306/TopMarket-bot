#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$project_root/dist/server"
cp "$project_root/worker/index.js" "$project_root/dist/server/index.js"
echo "Built $project_root/dist/server/index.js"
