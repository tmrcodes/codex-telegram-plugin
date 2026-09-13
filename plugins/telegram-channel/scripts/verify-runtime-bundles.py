#!/usr/bin/env python3
"""Rebuild runtime entrypoints in isolation and compare the exact publish set."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
ENTRIES = (
    "scripts/telegram-launcher.ts",
    "scripts/telegram-setup.ts",
    "scripts/telegram-bootstrap.ts",
    "app-server-controller/standalone-telegram-main.ts",
    "app-server-controller/standalone-telegram-access.ts",
)


def entries(root: Path) -> dict[str, bytes | None]:
    result: dict[str, bytes | None] = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise ValueError(f"runtime bundle has a symlink: {relative}")
        if path.is_dir():
            result[f"{relative}/"] = None
        elif path.is_file():
            result[relative] = path.read_bytes()
        else:
            raise ValueError(f"runtime bundle has a non-regular entry: {relative}")
    return result


def bundled_packages(meta: Path) -> dict[str, str]:
    inputs = json.loads(meta.read_text(encoding="utf-8"))["inputs"]
    names: set[str] = set()
    for source in inputs:
        if "node_modules/" not in source:
            continue
        parts = source.split("node_modules/", 1)[1].split("/")
        names.add("/".join(parts[:2]) if parts[0].startswith("@") else parts[0])
    result: dict[str, str] = {}
    for name in names:
        package = json.loads((ROOT / "node_modules" / name / "package.json").read_text(encoding="utf-8"))
        result[name] = package["version"]
    return result


def verify_notices(meta: Path) -> bool:
    packages = bundled_packages(meta)
    notice_path = ROOT / "THIRD_PARTY_NOTICES.md"
    notices = notice_path.read_text(encoding="utf-8") if notice_path.is_file() else ""
    headings = dict(re.findall(r"^## `([^`]+)` ([^\s]+)$", notices, re.MULTILINE))
    if headings != packages:
        print("third-party notice inventory does not match the runtime bundle", file=sys.stderr)
        return False
    for name, version in sorted(packages.items()):
        package_root = ROOT / "node_modules" / name
        candidates = sorted(path for path in package_root.iterdir() if path.is_file() and path.name.lower().startswith(("license", "licence")))
        if len(candidates) != 1:
            print(f"third-party license file is ambiguous: {name}", file=sys.stderr)
            return False
        heading = f"## `{name}` {version}\n\n"
        section = notices.split(heading, 1)[1].split("\n## `", 1)[0]
        if candidates[0].read_text(encoding="utf-8").strip() not in section:
            print(f"third-party license text is incomplete: {name}", file=sys.stderr)
            return False
    return True


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="codex-telegram-dist-") as raw:
        rebuilt = Path(raw) / "dist"
        meta = Path(raw) / "meta.json"
        result = subprocess.run(
            ["bun", "build", *ENTRIES, "--outdir", str(rebuilt), "--target=bun", "--minify", f"--metafile={meta}"],
            cwd=ROOT,
            check=False,
        )
        if result.returncode != 0:
            return result.returncode
        try:
            published, expected = entries(DIST), entries(rebuilt)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 1
        if published == expected and verify_notices(meta):
            print("Runtime bundles match the exact isolated rebuild.")
            return 0
        for path in sorted(published.keys() ^ expected.keys()):
            print(f"runtime bundle path mismatch: {path}", file=sys.stderr)
        for path in sorted(published.keys() & expected.keys()):
            if published[path] != expected[path]:
                print(f"runtime bundle content mismatch: {path}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
