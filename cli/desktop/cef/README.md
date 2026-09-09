# CEF desktop

Kavla uses a Chromium Embedded Framework window on Linux and macOS.
The frontend, Go HTTP server, DuckDB, and `.kavla` document format are shared.
The desktop build uses the `cef` Go build tag; ordinary CLI builds open the
system browser. The release workflow builds CLI binaries and CEF desktop
packages on Linux (amd64 and arm64) and macOS (Apple Silicon arm64 only).
AppImage smoke tests are disabled because startup under Xvfb times out without
a diagnosed cause. Go tests and native CEF compilation remain enabled. CEF assets are
named `kavla-desktop_*`; the CLI updater continues to use the ordinary CLI binaries.

From the repository root:

```sh
make build-app VERSION=local
./cli/dist/kavla-desktop_local_linux_amd64.AppImage
```

Pass a `.kavla` path to open an existing document. Closing the last CEF window
shuts down the Go server and saves the document. Ctrl+C also saves and exits.
Use a copy of a document when comparing builds, and close one build before
opening the same document in the other.

On macOS, `make build-app VERSION=local` produces
`cli/dist/kavla-desktop_local_darwin_arm64.zip`. Extract `Kavla.app` and
launch it in Finder. To open a specific document from a terminal, run
`Kavla.app/Contents/MacOS/Kavla open /path/to/document.kavla`.
The bundle includes the CEF framework and its sandboxed helper applications.
Closing the last window or choosing Quit saves and closes the Go backend.
macOS packages are ad-hoc signed and verified during packaging; Developer ID
signing and Apple notarization are not configured.

The first build downloads the pinned CEF minimal SDK (Chromium 152) and verifies
it against the checksum published by the CEF build service. It also downloads
the pinned AppImage packaging tools if they are not already cached. Downloads
and native build outputs live under `cli/build`; the AppImage and its SHA-256
checksum live under `cli/dist`. Build requirements are CMake 3.21+, a C++20
compiler, Go, Yarn with the app dependencies installed, curl, and tar with bzip2.
Linux builds support the local machine's amd64 or arm64 architecture. macOS
builds require Apple Silicon, Xcode command line tools, Python 3, and the system
signing tools.

For repeated native-only changes after building the frontend:

```sh
CEF_SKIP_WEB_BUILD=1 make build-app VERSION=local
```

On Linux, CEF ships its Chromium and ANGLE libraries in the AppImage. Desktop libraries
such as GTK, GLib, NSS, and the GPU drivers come from the host system. This
prototype is undergoing validation across distributions.

## Comparing rendering

The window uses CEF Views with Alloy styling: a normal desktop window without
browser tabs or an address bar. It uses Chromium's normal accelerated rendering
path, not offscreen rendering or a stream of copied frames.

Press **F12** to open Chromium DevTools and record a Performance trace while
panning or zooming the same canvas at the same window size and display scale.
Use these optional launch settings to compare display backends:

```sh
KAVLA_CEF_OZONE_PLATFORM=wayland ./cli/dist/kavla-desktop_local_linux_amd64.AppImage
KAVLA_CEF_OZONE_PLATFORM=x11 ./cli/dist/kavla-desktop_local_linux_amd64.AppImage
```

These display backend settings apply to Linux. The chosen backend must be available in the desktop session. No backend or
software-rendering mode is forced by default. Chromium's user-namespace sandbox
remains enabled; the AppImage does not require a root-owned setuid helper.
Ubuntu 24.04's AppArmor restrictions can require an application-specific
`userns` permission for unpackaged Chromium. The retained AppArmor test profile is
`.github/ci/kavla-desktop.apparmor`, which permits only the temporary test executable
without disabling Chromium's sandbox or changing the system-wide user namespace
policy. No smoke tests or AppArmor changes run in CI while smoke tests are disabled.

CEF/Chromium versions and main-frame load results are printed to the terminal.
Chromium writes additional logs to `$XDG_CACHE_HOME/kavla/cef/chromium.log`
(normally `~/.cache/kavla/cef/chromium.log`). Each launch uses a temporary,
isolated Chromium profile, so browser storage and browser preferences do not
persist between launches. The saved `.kavla` document and Kavla's CLI
configuration remain persistent.
