#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || "$(uname -s)" != Linux ]]; then
  echo "usage: $0 [version] (Linux only)" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
version="${1:-dev}"
version="${version:-dev}"
package_version="$(printf '%s' "${version#v}" | tr -c 'A-Za-z0-9.+~-' '-')"
cef_version='152.0.6+g708dc14+chromium-152.0.7977.83'

case "$(uname -m)" in
  x86_64)
    architecture=amd64
    cef_platform=linux64
    cef_project_arch=x86_64
    cef_sha1=9711b86c105fb590da576fe5a829802f1a79d520
    tool_arch=x86_64
    linuxdeploy_sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
    runtime_sha256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
    ;;
  aarch64|arm64)
    architecture=arm64
    cef_platform=linuxarm64
    cef_project_arch=arm64
    cef_sha1=d05e22542515b1022820651c75ba0c91fb9d8ad2
    tool_arch=aarch64
    linuxdeploy_sha256=620095110d693282b8ebeb244a95b5e911cf8f65f76c88b4b47d16ae6346fcff
    runtime_sha256=00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444
    ;;
  *) echo "unsupported CEF architecture: $(uname -m)" >&2; exit 1 ;;
esac

for command_name in cmake g++ go yarn curl sha1sum sha256sum tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required to build the CEF AppImage" >&2
    exit 1
  fi
done

download() {
  local url="$1" destination="$2" checksum="$3" check_command="$4"
  if [[ -f "$destination" ]] && printf '%s  %s\n' "$checksum" "$destination" | "$check_command" --check --status; then
    return
  fi
  curl --fail --location --retry 3 "$url" --output "$destination.download"
  printf '%s  %s\n' "$checksum" "$destination.download" | "$check_command" --check -
  mv "$destination.download" "$destination"
}

download_dir="$cli_dir/build/cef-downloads"
cef_name="cef_binary_${cef_version}_${cef_platform}_minimal"
archive="$download_dir/$cef_name.tar.bz2"
cef_root="$download_dir/$cef_name"
mkdir -p "$download_dir"
# These checksums are published in https://cef-builds.spotifycdn.com/index.json.
download "https://cef-builds.spotifycdn.com/${cef_name//+/%2B}.tar.bz2" "$archive" "$cef_sha1" sha1sum
if [[ ! -f "$cef_root/.kavla-extracted" ]]; then
  tar -xjf "$archive" -C "$download_dir"
  touch "$cef_root/.kavla-extracted"
fi

if [[ "${CEF_SKIP_WEB_BUILD:-0}" != 1 ]]; then
  "$script_dir/embed-web.sh"
fi
native_build="$cli_dir/build/cef-native"
# CEF's auto-detection recognizes arm64, but Linux ARM runners report aarch64.
cmake -S "$cli_dir/desktop/cef" -B "$native_build" \
  -DCEF_ROOT="$cef_root" -DPROJECT_ARCH="$cef_project_arch" \
  -DCMAKE_BUILD_TYPE=Release -DUSE_SANDBOX=ON
cmake --build "$native_build" --target kavla-cef --parallel "${CEF_BUILD_JOBS:-4}"

app_dir="$cli_dir/build/Kavla-CEF.AppDir"
rm -rf "$app_dir"
mkdir -p "$app_dir/usr/bin" "$app_dir/usr/lib/kavla-cef" \
  "$app_dir/usr/share/applications" "$app_dir/usr/share/icons/hicolor/scalable/apps" \
  "$app_dir/usr/share/mime/packages" "$app_dir/usr/share/doc/kavla-cef" "$cli_dir/dist"

(
  cd "$cli_dir"
  export GOCACHE="${GOCACHE:-$cli_dir/build/go-cache}"
  module_path="$(go list -m -f '{{.Path}}')"
  build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  CGO_ENABLED=1 go build -buildvcs=false -tags cef -trimpath \
    -ldflags "-s -w -X ${module_path}/cmd.Version=${version} -X ${module_path}/cmd.Commit=${COMMIT:-unknown} -X ${module_path}/cmd.BuildDate=${build_date}" \
    -o "$app_dir/usr/bin/kavla" .
)

install -m 0755 "$native_build/Release/kavla-cef" "$app_dir/usr/lib/kavla-cef/kavla-cef"
cp -a "$cef_root/Release/." "$app_dir/usr/lib/kavla-cef/"
cp -a "$cef_root/Resources/." "$app_dir/usr/lib/kavla-cef/"
install -m 0755 "$cli_dir/packaging/linux/cef-AppRun" "$app_dir/AppRun"
install -m 0755 "$cli_dir/packaging/linux/kavla-launcher" "$app_dir/usr/bin/kavla-cef-desktop"
install -m 0644 "$cli_dir/packaging/linux/kavla-cef.desktop" "$app_dir/usr/share/applications/kavla-cef.desktop"
install -m 0644 "$cli_dir/packaging/linux/kavla.xml" "$app_dir/usr/share/mime/packages/kavla.xml"
install -m 0644 "$repo_dir/app/public/kavla.svg" "$app_dir/usr/share/icons/hicolor/scalable/apps/kavla.svg"
ln -s usr/share/applications/kavla-cef.desktop "$app_dir/kavla-cef.desktop"
ln -s usr/share/icons/hicolor/scalable/apps/kavla.svg "$app_dir/kavla.svg"
for notice in LICENSE THIRD_PARTY_LICENSES.md TLDRAW_LICENSE.md; do
  install -m 0644 "$repo_dir/$notice" "$app_dir/usr/share/doc/kavla-cef/$notice"
done
install -m 0644 "$cef_root/LICENSE.txt" "$app_dir/usr/share/doc/kavla-cef/CEF-LICENSE.txt"
printf 'CEF %s\nBuild host: %s\n' "$cef_version" "$(uname -m)" > "$app_dir/usr/share/doc/kavla-cef/runtime-version.txt"

# Use only the AppImage output tool. CEF supplies its Chromium/ANGLE libraries;
# copying this build machine's GLib/GTK stack would interfere with host drivers.
tools_dir="$cli_dir/build/appimage-tools"
mkdir -p "$tools_dir"
download "https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-${tool_arch}.AppImage" \
  "$tools_dir/linuxdeploy.AppImage" "$linuxdeploy_sha256" sha256sum
download "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${tool_arch}" \
  "$tools_dir/runtime" "$runtime_sha256" sha256sum
chmod +x "$tools_dir/linuxdeploy.AppImage"
tool_extract="$cli_dir/build/cef-appimage-tools"
appimagetool="$tool_extract/squashfs-root/plugins/linuxdeploy-plugin-appimage/usr/bin/appimagetool"
if [[ ! -x "$appimagetool" ]]; then
  mkdir -p "$tool_extract"
  (cd "$tool_extract" && "$tools_dir/linuxdeploy.AppImage" --appimage-extract >/dev/null)
fi
output="$cli_dir/dist/kavla-cef_${package_version}_linux_${architecture}.AppImage"
ARCH="$tool_arch" "$appimagetool" "$app_dir" "$output" --runtime-file "$tools_dir/runtime"
(cd "$cli_dir/dist" && sha256sum "$(basename "$output")" > "$(basename "$output").sha256")
printf '\nBuilt %s\n' "$output"
