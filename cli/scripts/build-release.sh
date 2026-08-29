#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <version> <goos> <goarch> <output-dir>" >&2
  exit 1
fi

version="$1"
goos="$2"
goarch="$3"
output_dir="$4"

"$(dirname "$0")/embed-web.sh"

commit="${COMMIT:-unknown}"
build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
module_path="$(go list -m -f '{{.Path}}')"
ldflags="-s -w -X ${module_path}/cmd.Version=${version} -X ${module_path}/cmd.Commit=${commit} -X ${module_path}/cmd.BuildDate=${build_date}"

mkdir -p "$output_dir"
rm -f "$output_dir/kavla"

CGO_ENABLED=1 GOOS="$goos" GOARCH="$goarch" go build \
  -trimpath \
  -ldflags "$ldflags" \
  -o "$output_dir/.kavla.new" \
  .

mv "$output_dir/.kavla.new" "$output_dir/kavla"
