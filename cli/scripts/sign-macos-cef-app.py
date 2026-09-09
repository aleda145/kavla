#!/usr/bin/env python3
"""Ad-hoc sign a staged CEF app, including framework libraries and helpers."""

import argparse
from pathlib import Path
import subprocess


def sign_bundle(app):
    # Avoid following framework symlinks and sign each real Mach-O only once.
    mach_o = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
              b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
              b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}
    paths = list(app.rglob("*"))
    for path in paths:
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as file:
            if file.read(4) not in mach_o:
                continue
        subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
    bundles = [path for path in paths if path.is_dir() and not path.is_symlink()
               and path.suffix in {".app", ".framework"}]
    for bundle in sorted(bundles, key=lambda path: len(path.parts), reverse=True) + [app]:
        subprocess.run(["codesign", "--force", "--sign", "-", str(bundle)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    sign_bundle(args.app.resolve(strict=True))
