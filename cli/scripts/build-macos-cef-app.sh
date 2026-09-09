#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || "$(uname -s)" != Darwin ]]; then
  echo "usage: $0 [version] (macOS only)" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
version="${1:-dev}"
version="${version:-dev}"
package_version="$(printf '%s' "${version#v}" | tr -c 'A-Za-z0-9.+~-' '-')"
bundle_version=0.0.0
if [[ "$package_version" =~ ^([0-9]+\.[0-9]+\.[0-9]+) ]]; then
  bundle_version="${BASH_REMATCH[1]}"
fi
cef_version='152.0.6+g708dc14+chromium-152.0.7977.83'
case "$(uname -m)" in
  arm64)
    architecture=arm64
    cef_project_arch=arm64
    cef_platform=macosarm64
    cef_sha1=426836139b0ea7b7278aa0915cfae90eb460551f
    ;;
  *) echo "macOS desktop builds require Apple Silicon (arm64); got $(uname -m)" >&2; exit 1 ;;
esac

for command_name in cmake clang++ go yarn curl shasum tar ditto codesign python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required to build the CEF app" >&2
    exit 1
  fi
done

download_dir="$cli_dir/build/cef-downloads"
cef_name="cef_binary_${cef_version}_${cef_platform}_minimal"
archive="$download_dir/$cef_name.tar.bz2"
cef_root="$download_dir/$cef_name"
mkdir -p "$download_dir"
# Checksums are published in https://cef-builds.spotifycdn.com/index.json.
if [[ ! -f "$archive" ]] || ! printf '%s  %s\n' "$cef_sha1" "$archive" | shasum -a 1 --check --status; then
  curl --fail --location --retry 3 "https://cef-builds.spotifycdn.com/${cef_name//+/%2B}.tar.bz2" --output "$archive.download"
  printf '%s  %s\n' "$cef_sha1" "$archive.download" | shasum -a 1 --check -
  mv "$archive.download" "$archive"
fi
if [[ ! -f "$cef_root/.kavla-extracted" ]]; then
  tar -xjf "$archive" -C "$download_dir"
  touch "$cef_root/.kavla-extracted"
fi

if [[ "${CEF_SKIP_WEB_BUILD:-0}" != 1 ]]; then
  "$script_dir/embed-web.sh"
fi
native_build="$cli_dir/build/cef-native-macos-$architecture"
cmake -S "$cli_dir/desktop/cef" -B "$native_build" \
  -DCEF_ROOT="$cef_root" -DPROJECT_ARCH="$cef_project_arch" \
  -DCMAKE_BUILD_TYPE=Release -DUSE_SANDBOX=ON -DKAVLA_BUNDLE_VERSION="$bundle_version"
cmake --build "$native_build" --target kavla-cef --parallel "${CEF_BUILD_JOBS:-4}"

# Stage a fresh bundle so no files or signatures survive from an older build.
staging_dir="$(mktemp -d "$cli_dir/build/cef-macos-package.XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT
app_dir="$staging_dir/Kavla.app"
ditto "$native_build/Release/Kavla.app" "$app_dir"
mv "$app_dir/Contents/MacOS/Kavla" "$app_dir/Contents/MacOS/kavla-cef"
(
  cd "$cli_dir"
  export GOCACHE="${GOCACHE:-$cli_dir/build/go-cache}"
  module_path="$(go list -m -f '{{.Path}}')"
  build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  CGO_ENABLED=1 GOARCH="$architecture" go build -buildvcs=false -tags cef -trimpath \
    -ldflags "-s -w -X ${module_path}/cmd.Version=${version} -X ${module_path}/cmd.Commit=${COMMIT:-unknown} -X ${module_path}/cmd.BuildDate=${build_date}" \
    -o "$app_dir/Contents/MacOS/Kavla" .
)
mkdir -p "$app_dir/Contents/Resources/licenses"
for notice in LICENSE THIRD_PARTY_LICENSES.md TLDRAW_LICENSE.md; do
  install -m 0644 "$repo_dir/$notice" "$app_dir/Contents/Resources/licenses/$notice"
done
install -m 0644 "$cef_root/LICENSE.txt" "$app_dir/Contents/Resources/licenses/CEF-LICENSE.txt"

# Ad-hoc sign nested Mach-O files and bundles from the inside out. This is
# local code integrity signing, not Developer ID signing or notarization.
python3 "$script_dir/sign-macos-cef-app.py" "$app_dir"
codesign --verify --deep --strict "$app_dir"
mkdir -p "$cli_dir/dist"
output="$cli_dir/dist/kavla-cef_${package_version}_darwin_${architecture}.zip"
ditto -c -k --sequesterRsrc --keepParent "$app_dir" "$output"
(cd "$cli_dir/dist" && shasum -a 256 "$(basename "$output")" > "$(basename "$output").sha256")
printf '\nBuilt %s\n' "$output"
