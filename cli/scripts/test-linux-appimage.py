#!/usr/bin/env python3
"""Smoke test a release AppImage under dbus-run-session and xvfb-run."""

import argparse
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


STARTUP_TIMEOUT = 60
STABLE_SECONDS = 10
HELPERS = {"WebKitWebProcess", "WebKitNetworkProcess"}
FATAL_LOG = re.compile(
    r"error while loading shared libraries|undefined symbol:|Failed to load module:"
    r"|readPIDFromPeer:|SIGTRAP|SIGSEGV|Unable to spawn a new child process"
)


def webkit_helpers(root_pid):
    processes = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            parent = int(re.search(r"^PPid:\s+(\d+)", status, re.MULTILINE)[1])
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        processes[int(entry.name)] = parent

    descendants = {root_pid}
    while True:
        children = {pid for pid, parent in processes.items() if parent in descendants}
        if children <= descendants:
            break
        descendants.update(children)

    helpers = {}
    for pid in descendants:
        if pid not in processes:
            continue
        try:
            executable = (Path("/proc") / str(pid) / "exe").resolve(strict=True)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if executable.name not in HELPERS:
            continue
        try:
            environment = (Path("/proc") / str(pid) / "environ").read_bytes().split(b"\0")
            app_dir = next(item[7:].decode() for item in environment if item.startswith(b"APPDIR="))
            bundled_library = str(Path(app_dir) / "usr/lib/libwebkit2gtk-4.0.so")
            mappings = (Path("/proc") / str(pid) / "maps").read_text()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except StopIteration:
            raise RuntimeError(f"{executable.name} did not inherit APPDIR")
        if bundled_library not in mappings:
            if "libwebkit2gtk-4.0.so" in mappings:
                raise RuntimeError(f"{executable.name} is not using bundled WebKitGTK")
            continue  # The dynamic loader may not have mapped WebKitGTK yet.
        helpers[executable.name] = pid
    return helpers


def check_startup(process, log_path):
    deadline = time.monotonic() + STARTUP_TIMEOUT
    stable_since = None
    previous_helpers = {}
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"AppImage exited during startup with code {process.returncode}")
        output = log_path.read_text(errors="replace")
        failure = FATAL_LOG.search(output)
        if failure:
            raise RuntimeError(f"AppImage reported {failure[0]}")

        helpers = webkit_helpers(process.pid)
        window = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--name", "^Kavla"],
            capture_output=True, timeout=5,
        )
        server_ready = False
        address = re.search(r"Kavla is ready at (http://(?:localhost|127\.0\.0\.1):\d+/)", output)
        if address:
            try:
                with http.open(address[1], timeout=2) as response:
                    server_ready = response.status == 200
            except (urllib.error.URLError, TimeoutError):
                pass  # The server can still be starting; the deadline remains in effect.

        if server_ready and window.returncode == 0 and HELPERS <= helpers.keys():
            if stable_since is None or helpers != previous_helpers:
                stable_since = time.monotonic()
            if time.monotonic() - stable_since >= STABLE_SECONDS:
                print(f"AppImage passed: HTTP server, visible window, and bundled WebKit helpers stable for {STABLE_SECONDS}s.")
                return
        else:
            stable_since = None
        previous_helpers = helpers
        time.sleep(0.5)
    raise RuntimeError("Timed out waiting for the HTTP server, visible Kavla window, and stable WebKit helpers")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--log-dir", type=Path, required=True)
    args = parser.parse_args()
    appimage = args.appimage.resolve(strict=True)
    appimage.chmod(appimage.stat().st_mode | 0o111)
    args.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = args.log_dir / "appimage.log"

    with tempfile.TemporaryDirectory(prefix="kavla-appimage-test-") as work_dir:
        env = dict(os.environ)
        # First-run startup must use only bundled demo data and isolated settings.
        for variable, directory in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                                    ("XDG_CACHE_HOME", "cache"), ("XDG_DATA_HOME", "data"),
                                    ("XDG_RUNTIME_DIR", "runtime")]:
            path = Path(work_dir) / directory
            path.mkdir(mode=0o700)
            env[variable] = str(path)
        env.update(APPIMAGE_EXTRACT_AND_RUN="1", LIBGL_ALWAYS_SOFTWARE="1",
                   XDG_DATA_DIRS="/usr/local/share:/usr/share")
        # Exercise the packaged launcher's environment setup without inherited fixes.
        for variable in ["APPDIR", "LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GIO_EXTRA_MODULES"]:
            env.pop(variable, None)
        with log_path.open("w") as log:
            process = subprocess.Popen([str(appimage)], cwd=work_dir, env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                check_startup(process, log_path)
            finally:
                with (args.log_dir / "processes.log").open("w") as snapshot:
                    subprocess.run(["ps", "-eo", "pid,ppid,stat,args", "--forest"], stdout=snapshot, check=True)
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                print(log_path.read_text(errors="replace"))


if __name__ == "__main__":
    main()
