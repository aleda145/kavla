#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
app_dir="$(cd "$cli_dir/../app" && pwd)"
embed_dir="$cli_dir/internal/webapp/dist"

yarn --cwd "$app_dir" build
rm -rf "$embed_dir"
mkdir -p "$embed_dir"
cp -R "$app_dir/dist/." "$embed_dir/"
