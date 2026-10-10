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
binary_name="kavla_${version}_${goos}_${goarch}"
source_name=kavla
if [[ "$goos" == windows ]]; then
  source_name=kavla.exe
  binary_name+=.exe
fi

if [[ ! -f "$input_dir/$source_name" ]]; then
  echo "expected $input_dir/$source_name to exist" >&2
  exit 1
fi

mkdir -p "$dist_dir"
rm -f "$dist_dir/$binary_name"
install -m 0755 "$input_dir/$source_name" "$dist_dir/$binary_name"
