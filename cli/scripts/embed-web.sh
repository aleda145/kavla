#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
app_dir="$(cd "$cli_dir/../app" && pwd)"
embed_dir="$cli_dir/internal/webapp/dist"
stamp="$embed_dir/.build-stamp"

if command -v sha256sum >/dev/null 2>&1; then
  hash_command=(sha256sum)
else
  hash_command=(shasum -a 256)
fi

# Hash names and contents so additions, deletions, and branch switches invalidate
# the cache, while timestamp-only changes do not. Include this build script too.
fingerprint="$(
  cd "$cli_dir/.."
  find app cli/scripts/embed-web.sh \
    -type d \( -path app/node_modules -o -path app/dist -o -path app/.git \) -prune -o \
    -type f -exec "${hash_command[@]}" {} + \
    | LC_ALL=C sort \
    | "${hash_command[@]}"
)"

if [[ -f "$embed_dir/index.html" && -f "$stamp" && "$(cat "$stamp")" == "$fingerprint" ]]; then
  echo "Embedded frontend is up to date."
  exit 0
fi

yarn --cwd "$app_dir" build
test -f "$app_dir/dist/index.html"
rm -rf "$embed_dir"
mkdir -p "$embed_dir"
touch "$embed_dir/.gitkeep"
cp -R "$app_dir/dist/." "$embed_dir/"
printf '%s\n' "$fingerprint" > "$stamp"
