#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 2 ]]; then
  echo "usage: $0 [version] [prebuilt-wails-binary]" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$cli_dir/.." && pwd)"
package_root="$cli_dir/build/linux-package"
dist_dir="$cli_dir/dist"

source_version="${1:-dev}"
desktop_binary="${2:-}"
package_version="${source_version#v}"
package_version="$(printf '%s' "$package_version" | tr -c 'A-Za-z0-9.+~-' '-')"
if [[ ! "$package_version" =~ ^[0-9] ]]; then
  package_version="0~$package_version"
fi
architecture="$(dpkg --print-architecture)"
output="$dist_dir/kavla_${package_version}_linux_${architecture}.deb"
commit="${COMMIT:-unknown}"
build_date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
module_path="$(cd "$cli_dir" && go list -m -f '{{.Path}}')"
ldflags="-s -w -X ${module_path}/cmd.Version=${source_version} -X ${module_path}/cmd.Commit=${commit} -X ${module_path}/cmd.BuildDate=${build_date}"

rm -rf "$package_root"
mkdir -p "$package_root/DEBIAN" "$dist_dir"

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

install -Dm755 "$desktop_binary" "$package_root/usr/bin/kavla"
install -Dm755 "$cli_dir/packaging/linux/kavla-launcher" "$package_root/usr/bin/kavla-desktop"
install -Dm644 "$cli_dir/packaging/linux/kavla.desktop" "$package_root/usr/share/applications/kavla.desktop"
install -Dm644 "$repo_dir/app/public/kavla.svg" "$package_root/usr/share/icons/hicolor/scalable/apps/kavla.svg"
install -Dm644 "$cli_dir/packaging/linux/kavla.xml" "$package_root/usr/share/mime/packages/kavla.xml"
install -Dm644 "$repo_dir/LICENSE" "$package_root/usr/share/doc/kavla/LICENSE"
install -Dm644 "$repo_dir/THIRD_PARTY_LICENSES.md" "$package_root/usr/share/doc/kavla/THIRD_PARTY_LICENSES.md"
install -Dm644 "$repo_dir/TLDRAW_LICENSE.md" "$package_root/usr/share/doc/kavla/TLDRAW_LICENSE.md"
sed -e "s/@VERSION@/$package_version/g" -e "s/@ARCH@/$architecture/g" \
  "$cli_dir/packaging/linux/control.in" > "$package_root/DEBIAN/control"

rm -f "$output"
dpkg-deb --build --root-owner-group "$package_root" "$output"
printf 'Built %s\n' "$output"
