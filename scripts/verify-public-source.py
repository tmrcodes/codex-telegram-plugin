#!/usr/bin/env python3
"""Check the portable plugin tree for known private-source boundary violations.

This is a narrow, heuristic guardrail. It reports only a relative filename and
category, never matched content. Passing it does not prove that the repository
contains no secrets or private material; review and secret-scanning remain
required before publication.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
from pathlib import Path


SKIP_DIRECTORIES = {".git", "node_modules", "__pycache__"}
GENERATED_RUNTIME_BUNDLES = frozenset(
    {
        Path("plugins/telegram-channel/dist/app-server-controller/standalone-telegram-access.js"),
        Path("plugins/telegram-channel/dist/app-server-controller/standalone-telegram-main.js"),
        Path("plugins/telegram-channel/dist/scripts/telegram-bootstrap.js"),
        Path("plugins/telegram-channel/dist/scripts/telegram-launcher.js"),
        Path("plugins/telegram-channel/dist/scripts/telegram-setup.js"),
    }
)
RUNTIME_NAMES = {
    "auth.json",
    "credentials.json",
    "secrets.json",
    "session.json",
    "runtime.ts",
    "session.ts",
    "peer.ts",
    "controller-bridge.ts",
    "telegram-reply-bridge.ts",
}
RUNTIME_SUFFIXES = (".db", ".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm")
PRIVATE_KEY_SUFFIXES = (".pem", ".p12", ".pfx", ".key")
PRIVATE_KEY_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
BOT_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])\d{5,}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])")
# Keep the path pieces separate so this scanner does not report its own pattern.
PRIVATE_HOME = re.compile(
    r"(?:"
    + r"/"
    + r"(?:Users|home)"
    + r"/"
    + r"[^/\s'\"]+"
    + r"|~/"
    + r"(?:\.codex|\.config)/"
    + r"|[A-Za-z]:"
    + r"\\+"
    + r"Users"
    + r"\\+"
    + r"[^\\\s'\"]+"
    + r")"
)
PRIVATE_KEY = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
GITHUB_TOKEN = re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,})\b")
AWS_ACCESS_KEY = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
LITERAL_USERNAME = re.compile(r"(?<![A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_]{0,31})(?![A-Za-z0-9_])")
APPROVED_PUBLIC_OR_SYNTHETIC_USERNAMES = {
    "ada",
    "bot",
    "botfather",
    "bun",
    "cfworker",
    "codex",
    "grammyjs",
    "hono",
    "modelcontextprotocol",
    "ops",
    "sample",
    "synthetic_bot",
    "types",
}
LONG_NUMERIC_ID = re.compile(r"(?<![A-Za-z0-9_])-?\d(?:_?\d){6,19}(?![A-Za-z0-9_])")
# A test UUID made of repeated digits in each field is a reviewed, visibly
# synthetic fixture. RFC 4122 version/variant digits may differ from the
# repeated digit in their field. Only this pattern is exempt from the numeric
# check; this is not a general detector for private UUIDs.
SYNTHETIC_TEST_UUID = re.compile(
    r"\b(?P<a>[0-9])(?P=a){7}-(?P<b>[0-9])(?P=b){3}-"
    r"(?:(?P<c>[0-9])(?P=c){3}|[1-5](?P<cv>[0-9])(?P=cv){2})-"
    r"(?:(?P<d>[0-9])(?P=d){3}|[89](?P<dv>[0-9])(?P=dv){2})-"
    r"(?P<e>[0-9])(?P=e){11}\b"
)
PRIVATE_CONTROLLER_MODULES = ("runtime", "session", "peer", "controller-bridge", "telegram-reply-bridge")
FORBIDDEN_IMPORT = re.compile(
    r"^\s*import(?:[\s\S]*?\sfrom)?\s*['\"][^'\"]*(?:"
    r"(?:^|/)(?:"
    + "|".join(re.escape(name) for name in PRIVATE_CONTROLLER_MODULES)
    + r"))(?:\.ts)?['\"]",
    re.MULTILINE,
)
FORBIDDEN_SOCKET_ENV = re.compile(r"\bAPP_SERVER_TELEGRAM_REPLY_SOCKET\b")
PRIVATE_DATABASE_MODULES = ("node:" + "sqlite", "better-" + "sqlite", "falkor" + "db", "qdrant")
FORBIDDEN_DB_IMPORT = re.compile(
    r"(?:from\s+['\"](?:"
    + "|".join(re.escape(name) for name in PRIVATE_DATABASE_MODULES)
    + r")[\'\"])",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root to check (default: this script's parent)",
    )
    return parser.parse_args()


def category_for_path(relative: Path) -> str | None:
    name = relative.name.lower()
    parts = {part.lower() for part in relative.parts}
    if name in RUNTIME_NAMES:
        return "private-runtime-artifact"
    if name == ".env" or name.startswith(".env."):
        return "environment-artifact"
    if name.endswith(RUNTIME_SUFFIXES):
        return "runtime-database-artifact"
    if name in PRIVATE_KEY_NAMES or name.endswith(PRIVATE_KEY_SUFFIXES):
        return "private-key-artifact"
    if "runtime" in parts or "sessions" in parts or "state" in parts:
        return "runtime-data-artifact"
    return None


def is_test_file(relative: Path) -> bool:
    return relative.name.endswith((".test.ts", ".test.py"))


def categories_for_text(relative: Path, text: str) -> set[str]:
    findings: set[str] = set()
    if BOT_TOKEN.search(text):
        findings.add("bot-credential")
    if PRIVATE_KEY.search(text):
        findings.add("private-key-credential")
    if GITHUB_TOKEN.search(text):
        findings.add("github-credential")
    if AWS_ACCESS_KEY.search(text):
        findings.add("aws-access-key-id")
    if PRIVATE_HOME.search(text):
        findings.add("private-home-path")
    if FORBIDDEN_IMPORT.search(text):
        findings.add("private-controller-import")
    if FORBIDDEN_SOCKET_ENV.search(text):
        findings.add("private-socket-bridge")
    if FORBIDDEN_DB_IMPORT.search(text):
        findings.add("runtime-database-import")
    username_text = re.sub(r"^\s*import.*$", "", text, flags=re.MULTILINE)
    for username in LITERAL_USERNAME.findall(username_text):
        if username.lower() not in APPROVED_PUBLIC_OR_SYNTHETIC_USERNAMES:
            findings.add("unapproved-username")
            break
    numeric_text = SYNTHETIC_TEST_UUID.sub("", text) if is_test_file(relative) else text
    if relative not in GENERATED_RUNTIME_BUNDLES and LONG_NUMERIC_ID.search(numeric_text):
        findings.add("unapproved-long-numeric-id")
    return findings


def walk_repository(root: Path) -> list[tuple[str, str]]:
    plugin = root / "plugins" / "telegram-channel"
    if not plugin.is_dir():
        return [("plugins/telegram-channel", "missing-plugin-tree")]
    findings: list[tuple[str, str]] = []
    for directory, subdirs, files in os.walk(root, followlinks=False):
        current = Path(directory)
        for entry in list(subdirs):
            candidate = current / entry
            relative = candidate.relative_to(root)
            if candidate.is_symlink():
                findings.append((relative.as_posix(), "symlink"))
                subdirs.remove(entry)
            elif entry in SKIP_DIRECTORIES:
                subdirs.remove(entry)
            elif (category := category_for_path(relative)) is not None:
                findings.append((relative.as_posix(), category))
        for entry in files:
            candidate = current / entry
            relative = candidate.relative_to(root)
            if candidate.is_symlink():
                findings.append((relative.as_posix(), "symlink"))
                continue
            try:
                mode = candidate.lstat().st_mode
            except OSError:
                findings.append((relative.as_posix(), "uninspectable-artifact"))
                continue
            if not stat.S_ISREG(mode):
                findings.append((relative.as_posix(), "non-regular-artifact"))
                continue
            if (category := category_for_path(relative)) is not None:
                findings.append((relative.as_posix(), category))
                continue
            try:
                text = candidate.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                findings.append((relative.as_posix(), "non-text-artifact"))
                continue
            except OSError:
                findings.append((relative.as_posix(), "uninspectable-artifact"))
                continue
            for category in categories_for_text(relative, text):
                findings.append((relative.as_posix(), category))
    return sorted(set(findings))


def main() -> int:
    root = parse_args().root.resolve()
    findings = walk_repository(root)
    for relative, category in findings:
        print(f"{relative}: {category}", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
