# Local CEF desktop prototype

This builds Kavla with a Chromium Embedded Framework window instead of Wails.
The frontend, Go HTTP server, DuckDB, and `.kavla` document format are shared.
The CEF build uses the `cef` Go build tag; ordinary CLI and Wails builds retain
their existing behavior. The release workflow builds both Linux variants and
smoke tests each on Ubuntu 22.04 and 24.04, on amd64 and arm64. CEF assets are
named `kavla-cef_*`; the CLI updater continues to use the ordinary CLI binaries.

From the repository root:

```sh
make build-cef-appimage VERSION=local
./cli/dist/kavla-cef_local_linux_amd64.AppImage
```

Pass a `.kavla` path to open an existing document. Closing the last CEF window
shuts down the Go server and saves the document. Ctrl+C also saves and exits.
Use a copy of a document when comparing builds, and close one build before
opening the same document in the other.

The first build downloads the pinned CEF minimal SDK (Chromium 152) and verifies
it against the checksum published by the CEF build service. It also downloads
the pinned AppImage packaging tools if they are not already cached. Downloads
and native build outputs live under `cli/build`; the AppImage and its SHA-256
checksum live under `cli/dist`. Build requirements are CMake 3.21+, a C++20
compiler, Go, Yarn with the app dependencies installed, curl, and tar with bzip2.
The build supports the local machine's amd64 or arm64 architecture.

For repeated native-only changes after building the frontend:

```sh
CEF_SKIP_WEB_BUILD=1 make build-cef-appimage VERSION=local
```

CEF ships its Chromium and ANGLE libraries in the AppImage. Desktop libraries
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
KAVLA_CEF_OZONE_PLATFORM=wayland ./cli/dist/kavla-cef_local_linux_amd64.AppImage
KAVLA_CEF_OZONE_PLATFORM=x11 ./cli/dist/kavla-cef_local_linux_amd64.AppImage
```

The chosen backend must be available in the desktop session. No backend or
software-rendering mode is forced by default. Chromium's user-namespace sandbox
remains enabled; the AppImage does not require a root-owned setuid helper.
Ubuntu 24.04's AppArmor restrictions can require an application-specific
`userns` permission for unpackaged Chromium. The CI jobs load
`.github/ci/kavla-cef.apparmor`, which permits only the temporary test executable;
they do not disable Chromium's sandbox or change the system-wide user namespace
policy.

CEF/Chromium versions and main-frame load results are printed to the terminal.
Chromium writes additional logs to `$XDG_CACHE_HOME/kavla/cef/chromium.log`
(normally `~/.cache/kavla/cef/chromium.log`). Each launch uses a temporary,
isolated Chromium profile, so browser storage and browser preferences do not
persist between launches. The saved `.kavla` document and Kavla's CLI
configuration remain persistent.
