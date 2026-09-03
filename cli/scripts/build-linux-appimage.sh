#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 4 ]]; then
  echo "usage: $0 [version] [prebuilt-wails-binary] [linuxdeploy] [appimage-runtime]" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
app_dir="$cli_dir/build/Kavla.AppDir"
dist_dir="$cli_dir/dist"

source_version="${1:-dev}"
desktop_binary="${2:-}"
linuxdeploy="${3:-${LINUXDEPLOY:-linuxdeploy}}"
appimage_runtime="${4:-${APPIMAGE_RUNTIME_FILE:-}}"
package_version="${source_version#v}"
package_version="$(printf '%s' "$package_version" | tr -c 'A-Za-z0-9.+~-' '-')"
architecture="${GOARCH:-}"

if [[ -z "$architecture" ]]; then
  case "$(uname -m)" in
    x86_64) architecture=amd64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) architecture="$(uname -m)" ;;
  esac
fi

if [[ -n "$appimage_runtime" && ! -f "$appimage_runtime" ]]; then
  echo "expected AppImage runtime $appimage_runtime to exist" >&2
  exit 1
fi

case "$architecture" in
  amd64)
    tool_arch=x86_64
    linuxdeploy_sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
    runtime_sha256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
    ;;
  arm64)
    tool_arch=aarch64
    linuxdeploy_sha256=620095110d693282b8ebeb244a95b5e911cf8f65f76c88b4b47d16ae6346fcff
    runtime_sha256=00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444
    ;;
  *)
    echo "unsupported AppImage architecture: $architecture" >&2
    exit 1
    ;;
esac

download_tool() {
  local url="$1"
  local destination="$2"
  local sha256="$3"

  if [[ -f "$destination" ]] && printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status; then
    return
  fi

  echo "Downloading $(basename "$destination")"
  curl --fail --location --retry 3 "$url" --output "$destination.download"
  printf '%s  %s\n' "$sha256" "$destination.download" | sha256sum --check -
  mv "$destination.download" "$destination"
}

if [[ $# -lt 3 && -z "${LINUXDEPLOY:-}" ]]; then
  for command_name in curl sha256sum; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "$command_name is required to download AppImage build tools" >&2
      exit 1
    fi
  done

  tools_dir="$cli_dir/build/appimage-tools"
  linuxdeploy="$tools_dir/linuxdeploy.AppImage"
  if [[ -z "$appimage_runtime" ]]; then
    appimage_runtime="$tools_dir/runtime"
  fi

  mkdir -p "$tools_dir"
  download_tool \
    "https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-${tool_arch}.AppImage" \
    "$linuxdeploy" \
    "$linuxdeploy_sha256"
  download_tool \
    "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/7a3fbc31a9e5075073ff8790f26effbac5f84453/linuxdeploy-plugin-gtk.sh" \
    "$tools_dir/linuxdeploy-plugin-gtk.sh" \
    b0f4cbc684a0103a9651f0955b635eaea0096b3a66c0f5a2c2aa337960375171
  download_tool \
    "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${tool_arch}" \
    "$appimage_runtime" \
    "$runtime_sha256"
  chmod +x "$linuxdeploy" "$tools_dir/linuxdeploy-plugin-gtk.sh"
fi

output="$dist_dir/kavla_${package_version}_linux_${architecture}.AppImage"
commit="${COMMIT:-unknown}"
build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
module_path="$(cd "$cli_dir" && go list -m -f '{{.Path}}')"
ldflags="-s -w -X ${module_path}/cmd.Version=${source_version} -X ${module_path}/cmd.Commit=${commit} -X ${module_path}/cmd.BuildDate=${build_date}"

if [[ "$linuxdeploy" == */* ]]; then
  if [[ ! -x "$linuxdeploy" ]]; then
    echo "expected linuxdeploy executable $linuxdeploy to exist" >&2
    exit 1
  fi
else
  linuxdeploy="$(command -v "$linuxdeploy" || true)"
  if [[ -z "$linuxdeploy" ]]; then
    echo "linuxdeploy is required to build an AppImage" >&2
    exit 1
  fi
fi

rm -rf "$app_dir"
mkdir -p "$app_dir/usr/bin" "$app_dir/usr/share/mime/packages" "$app_dir/usr/share/doc/kavla" "$dist_dir"

if [[ -z "$desktop_binary" ]]; then
  (
    cd "$cli_dir"
    wails build -s -skipbindings -nopackage -trimpath -ldflags "$ldflags" -o kavla
  )
  desktop_binary="$cli_dir/build/bin/kavla"
elif [[ ! -f "$desktop_binary" ]]; then
  echo "expected prebuilt Wails binary $desktop_binary to exist" >&2
  exit 1
fi

install -m 0755 "$desktop_binary" "$app_dir/usr/bin/kavla"
install -m 0755 "$cli_dir/packaging/linux/kavla-launcher" "$app_dir/usr/bin/kavla-desktop"
install -m 0644 "$cli_dir/packaging/linux/kavla.xml" "$app_dir/usr/share/mime/packages/kavla.xml"
install -m 0644 "$repo_dir/LICENSE" "$app_dir/usr/share/doc/kavla/LICENSE"
install -m 0644 "$repo_dir/THIRD_PARTY_LICENSES.md" "$app_dir/usr/share/doc/kavla/THIRD_PARTY_LICENSES.md"
install -m 0644 "$repo_dir/TLDRAW_LICENSE.md" "$app_dir/usr/share/doc/kavla/TLDRAW_LICENSE.md"

webkit_library="$(ldd "$desktop_binary" | awk '/libwebkit2gtk-4\.0\.so/ { print $3; exit }')"
if [[ -z "$webkit_library" || ! -f "$webkit_library" ]]; then
  echo "unable to locate the WebKitGTK 4.0 runtime used by $desktop_binary" >&2
  exit 1
fi

# WebKitGTK stores its helper paths inside the shared library. Keep an AppDir
# copy at the matching relative path and make the /usr prefix relocatable.
webkit_lib_dir="$(pkg-config --variable=libdir webkit2gtk-4.0)"
webkit_process_dir="$webkit_lib_dir/webkit2gtk-4.0"
for helper in WebKitWebProcess WebKitNetworkProcess; do
  if [[ ! -x "$webkit_process_dir/$helper" ]]; then
    echo "missing WebKitGTK helper: $webkit_process_dir/$helper" >&2
    exit 1
  fi
  install -Dm755 "$webkit_process_dir/$helper" "$app_dir/${webkit_process_dir#/}/$helper"
done
if [[ -x "$webkit_process_dir/WebKitGPUProcess" ]]; then
  install -Dm755 "$webkit_process_dir/WebKitGPUProcess" "$app_dir/${webkit_process_dir#/}/WebKitGPUProcess"
fi

injected_bundle="$webkit_process_dir/injected-bundle/libwebkit2gtkinjectedbundle.so"
if [[ ! -f "$injected_bundle" ]]; then
  echo "missing WebKitGTK injected bundle: $injected_bundle" >&2
  exit 1
fi
install -Dm644 "$injected_bundle" "$app_dir/${injected_bundle#/}"

bundled_webkit="$app_dir/usr/lib/$(basename "$webkit_library")"
install -Dm644 "$webkit_library" "$bundled_webkit"
sed -i -e 's|/usr|././|g' "$bundled_webkit"

rm -f "$output"
linuxdeploy_env=(
  "APPIMAGE_EXTRACT_AND_RUN=1"
  "DEPLOY_GTK_VERSION=3"
  "LD_LIBRARY_PATH=$app_dir/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  "LDAI_OUTPUT=$output"
  "LINUXDEPLOY_OUTPUT_VERSION=$package_version"
  "OUTPUT=$output"
  "VERSION=$package_version"
)
if [[ -n "$appimage_runtime" ]]; then
  linuxdeploy_env+=("LDAI_RUNTIME_FILE=$appimage_runtime")
fi

env "${linuxdeploy_env[@]}" "$linuxdeploy" \
  --appdir "$app_dir" \
  --executable "$app_dir/usr/bin/kavla" \
  --desktop-file "$cli_dir/packaging/linux/kavla.desktop" \
  --icon-file "$repo_dir/app/public/kavla.svg" \
  --custom-apprun "$cli_dir/packaging/linux/AppRun" \
  --plugin gtk \
  --output appimage

if [[ ! -f "$output" ]]; then
  echo "linuxdeploy did not create $output" >&2
  exit 1
fi

printf 'Built %s\n' "$output"
