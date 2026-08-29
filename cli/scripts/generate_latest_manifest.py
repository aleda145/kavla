#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

TARGETS = [
    ("linux", "amd64"),
    ("linux", "arm64"),
    ("darwin", "amd64"),
    ("darwin", "arm64"),
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--dist-dir", required=True)
    parser.add_argument("--published-at", required=True)
    parser.add_argument("--notes-url", required=True)
    args = parser.parse_args()

    dist_dir = Path(args.dist_dir)
    assets: dict[str, dict[str, str]] = {}

    for goos, goarch in TARGETS:
        filename = f"kavla_{args.version}_{goos}_{goarch}.tar.gz"
        path = dist_dir / filename
        if not path.is_file():
            raise SystemExit(f"missing release archive: {path}")
        assets[f"{goos}-{goarch}"] = {
            "url": f"https://github.com/{args.repo}/releases/download/{args.version}/{filename}",
            "sha256": sha256_file(path),
            "archive_format": "tar.gz",
            "binary_name": "kavla",
        }

    manifest = {
        "version": args.version,
        "published_at": args.published_at,
        "notes_url": args.notes_url,
        "assets": assets,
    }

    output_path = dist_dir / "kavla_latest.json"
    output_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
