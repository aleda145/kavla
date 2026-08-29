#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <version> <goos> <goarch> <input-dir> <dist-dir>" >&2
  exit 1
fi

version="$1"
goos="$2"
goarch="$3"
input_dir="$4"
dist_dir="$5"
archive_name="kavla-desktop_${version}_${goos}_${goarch}.tar.gz"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"

if [[ ! -f "$input_dir/kavla" ]]; then
  echo "expected $input_dir/kavla to exist" >&2
  exit 1
fi

mkdir -p "$dist_dir"
rm -f "$dist_dir/$archive_name"
tar -czf "$dist_dir/$archive_name" \
  -C "$input_dir" kavla \
  -C "$repo_dir" LICENSE THIRD_PARTY_LICENSES.md TLDRAW_LICENSE.md
