#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [version] (Windows x64, Git Bash)" >&2
  exit 1
fi
case "$(uname -s)" in
  MINGW*|MSYS*) ;;
  *) echo "Build the Windows desktop package on Windows using Git Bash." >&2; exit 1 ;;
esac
if [[ "$(go env GOHOSTARCH)" != amd64 ]]; then
  echo "Windows desktop builds require an x64 Go installation." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
version="${1:-dev}"
version="${version:-dev}"
package_version="$(printf '%s' "${version#v}" | tr -c 'A-Za-z0-9.+~-' '-')"
cef_version='152.0.6+g708dc14+chromium-152.0.7977.83'
# Published by https://cef-builds.spotifycdn.com/ for this minimal Windows SDK.
cef_sha1=e5e3020627f4528bd43e22f4c4970000b0458e99

for command_name in cmake go gcc g++ yarn curl sha1sum sha256sum tar cygpath; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required to build the Windows desktop package" >&2
    exit 1
  fi
done

download_dir="$cli_dir/build/cef-downloads"
cef_name="cef_binary_${cef_version}_windows64_minimal"
archive="$download_dir/$cef_name.tar.bz2"
cef_root="$download_dir/$cef_name"
mkdir -p "$download_dir"
if [[ ! -f "$archive" ]] || ! printf '%s  %s\n' "$cef_sha1" "$archive" | sha1sum --check --status; then
  curl --fail --location --retry 3 "https://cef-builds.spotifycdn.com/${cef_name//+/%2B}.tar.bz2" --output "$archive.download"
  printf '%s  %s\n' "$cef_sha1" "$archive.download" | sha1sum --check -
  mv "$archive.download" "$archive"
fi
if [[ ! -f "$cef_root/.kavla-extracted" ]]; then
  tar -xjf "$archive" -C "$download_dir"
  touch "$cef_root/.kavla-extracted"
fi

if [[ "${CEF_SKIP_WEB_BUILD:-0}" != 1 ]]; then
  "$script_dir/embed-web.sh"
fi
native_build="$cli_dir/build/cef-native-windows-amd64"
cmake -S "$cli_dir/desktop/cef" -B "$native_build" \
  -G "Visual Studio 17 2022" -A x64 \
  -DCEF_ROOT="$(cygpath -m "$cef_root")" -DPROJECT_ARCH=x86_64 \
  -DUSE_SANDBOX=ON -DUSE_ATL=OFF
cmake --build "$native_build" --config Release --target kavla-desktop --parallel "${CEF_BUILD_JOBS:-4}"

staging_dir="$(mktemp -d "$cli_dir/build/cef-windows-package.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT
app_dir="$staging_dir/Kavla"
mkdir -p "$app_dir/cef" "$app_dir/licenses"
for file in "$native_build/Release/"*; do
  case "$file" in
    *.dll|*.exe|*.bin|*.json|*.pak|*.dat|*/locales) cp -R "$file" "$app_dir/cef/" ;;
  esac
done
test -f "$app_dir/cef/kavla-desktop.exe"
test -f "$app_dir/cef/kavla-desktop.dll"
(
  cd "$cli_dir"
  module_path="$(go list -m -f '{{.Path}}')"
  build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  CGO_ENABLED=1 GOOS=windows GOARCH=amd64 go build -buildvcs=false -tags cef -trimpath \
    -ldflags "-s -w -extldflags=-static -X ${module_path}/cmd.Version=${version} -X ${module_path}/cmd.Commit=${COMMIT:-unknown} -X ${module_path}/cmd.BuildDate=${build_date}" \
    -o "$app_dir/Kavla.exe" .
)
for notice in LICENSE THIRD_PARTY_LICENSES.md TLDRAW_LICENSE.md; do
  cp "$repo_dir/$notice" "$app_dir/licenses/$notice"
done
cp "$cef_root/LICENSE.txt" "$app_dir/licenses/CEF-LICENSE.txt"
mkdir -p "$cli_dir/dist"
output="$cli_dir/dist/kavla-desktop_${package_version}_windows_amd64.zip"
(cd "$staging_dir" && cmake -E tar cf "$output" --format=zip Kavla)
(cd "$cli_dir/dist" && sha256sum "$(basename "$output")" > "$(basename "$output").sha256")
printf '\nBuilt %s\n' "$output"
