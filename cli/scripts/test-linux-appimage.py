#!/usr/bin/env python3
"""Smoke test a release AppImage under dbus-run-session and xvfb-run."""

import argparse
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


STARTUP_TIMEOUT = 60
STABLE_SECONDS = 10
CEF_HELPERS = {"renderer", "gpu-process"}
FATAL_LOG = re.compile(
    r"error while loading shared libraries|undefined symbol:|Failed to load module:"
    r"|readPIDFromPeer:|SIGTRAP|SIGSEGV|SIGABRT|Unable to spawn a new child process"
    r"|CEF renderer exited:|CEF failed to load |No usable sandbox|FATAL:"
)


def descendant_processes(root_pid):
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
    return descendants


def cef_helpers(root_pid):
    helpers = {}
    for pid in descendant_processes(root_pid):
        try:
            arguments = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        # Chromium's sandbox can restrict /proc/exe and /proc/maps access. Its
        # command line still identifies the packaged helper and process role.
        if not arguments or not arguments[0].endswith(b"/usr/lib/kavla-desktop/kavla-desktop"):
            continue
        for role in CEF_HELPERS:
            if f"--type={role}".encode() in arguments:
                helpers[role] = pid
    return helpers


def check_startup(process, log_path, engine="cef", chromium_log=None):
    deadline = time.monotonic() + STARTUP_TIMEOUT
    stable_since = None
    previous_helpers = {}
    last_report = 0
    readiness = "No startup checks completed"
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"AppImage exited during startup with code {process.returncode}")
        output = log_path.read_text(errors="replace")
        diagnostic_output = output
        if chromium_log is not None and chromium_log.is_file():
            diagnostic_output += "\n" + chromium_log.read_text(errors="replace")
        failure = FATAL_LOG.search(diagnostic_output)
        if failure:
            raise RuntimeError(f"AppImage reported {failure[0]}")

        helpers = cef_helpers(process.pid)
        required_helpers = CEF_HELPERS
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

        page_loaded = bool(address and f"CEF loaded {address[1]} (HTTP 200)" in output)
        readiness = (
            f"HTTP ready={server_ready}, visible window={window.returncode == 0}, "
            f"page loaded={page_loaded}, helpers={helpers}, "
            f"missing helpers={sorted(required_helpers - helpers.keys())}"
        )
        if time.monotonic() - last_report >= 10:
            print(f"Waiting for {engine}: {readiness}", flush=True)
            last_report = time.monotonic()
        if server_ready and page_loaded and window.returncode == 0 and required_helpers <= helpers.keys():
            if stable_since is None or helpers != previous_helpers:
                stable_since = time.monotonic()
            if time.monotonic() - stable_since >= STABLE_SECONDS:
                print(f"{engine} AppImage passed: HTTP server, visible window, and helpers stable for {STABLE_SECONDS}s.")
                return
        else:
            stable_since = None
        previous_helpers = helpers
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for stable {engine} startup: {readiness}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("appimage", type=Path)
    parser.add_argument("--engine", choices=["cef"], default="cef")
    parser.add_argument("--log-dir", type=Path, required=True)
    args = parser.parse_args()
    appimage = args.appimage.resolve(strict=True)
    appimage.chmod(appimage.stat().st_mode | 0o111)
    args.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = args.log_dir / "appimage.log"

    with tempfile.TemporaryDirectory(prefix="kavla-appimage-test-", dir="/tmp") as work_dir:
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
        if args.engine == "cef":
            env.update(TMPDIR=work_dir, KAVLA_CEF_OZONE_PLATFORM="x11")
        # Exercise the packaged launcher's environment setup without inherited fixes.
        for variable in ["APPDIR", "LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GIO_EXTRA_MODULES"]:
            env.pop(variable, None)
        chromium_log = Path(env["XDG_CACHE_HOME"]) / "kavla/cef/chromium.log"
        with log_path.open("w") as log:
            process = subprocess.Popen([str(appimage)], cwd=work_dir, env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                check_startup(process, log_path, args.engine, chromium_log)
            finally:
                with (args.log_dir / "processes.log").open("w") as snapshot:
                    subprocess.run(["ps", "-eo", "pid,ppid,stat,args", "--forest"], stdout=snapshot, check=True)
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=45)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                print(log_path.read_text(errors="replace"), flush=True)
                if chromium_log.is_file():
                    shutil.copy2(chromium_log, args.log_dir / "chromium.log")
                    print("CEF Chromium log:", flush=True)
                    print(chromium_log.read_text(errors="replace"), flush=True)


if __name__ == "__main__":
    main()
