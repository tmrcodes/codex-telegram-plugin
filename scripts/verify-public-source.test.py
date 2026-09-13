#!/usr/bin/env python3
"""Focused no-network checks for verify-public-source.py."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CHECKER = Path(__file__).with_name("verify-public-source.py")


def write_plugin(root: Path, name: str, text: str = "export const safe = true\n") -> Path:
    path = root / "plugins" / "telegram-channel" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_root_file(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def synthetic_bot_token() -> str:
    return ":".join((str(123456) + "789", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"))


def private_home_path() -> str:
    return "/" + "/".join(("Users", "example", "private"))


def windows_home_path(*, escaped: bool = False) -> str:
    separator = "\\"
    value = "C:" + separator + separator.join(("Users", "example", "private"))
    return value.replace(separator, separator * 2) if escaped else value


class VerifyPublicSourceTests(unittest.TestCase):
    def run_checker(self, root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECKER), "--root", str(root)],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_allows_generic_fixture_data_and_synthetic_uuid(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            synthetic_uuid = "-".join(("1" * 8, "2" * 4, "4" + "3" * 3, "8" + "4" * 3, "5" * 12))
            write_plugin(root, "adapter.test.ts", f"const fixture = '@sample'; const official = '@BotFather'; const thread = '{synthetic_uuid}'\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_reports_categories_without_echoing_sensitive_matches(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            token = synthetic_bot_token()
            private_path = private_home_path()
            write_plugin(root, "unsafe.ts", f"const token = '{token}'; const path = '{private_path}'\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/unsafe.ts: bot-credential", result.stderr)
            self.assertIn("plugins/telegram-channel/unsafe.ts: private-home-path", result.stderr)
            self.assertNotIn(token, result.stderr)
            self.assertNotIn(private_path, result.stderr)

    def test_rejects_private_import_and_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = write_plugin(root, "target.ts")
            module = "controller" + "-bridge"
            write_plugin(root, "unsafe.ts", f"import {{ value }} from './{module}'\n")
            (target.parent / "linked.ts").symlink_to(target.name)
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("private-controller-import", result.stderr)
            self.assertIn("symlink", result.stderr)

    def test_checks_files_outside_the_plugin_tree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            private_path = private_home_path()
            (root / "README.md").write_text(f"local path: {private_path}\n", encoding="utf-8")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("README.md: private-home-path", result.stderr)

    def test_rejects_literal_and_javascript_escaped_windows_private_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            literal_path = windows_home_path()
            escaped_path = windows_home_path(escaped=True)
            write_root_file(root, "README.md", f"literal: {literal_path}\nescaped: {escaped_path}\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("README.md: private-home-path", result.stderr)
            self.assertNotIn(literal_path, result.stderr)
            self.assertNotIn(escaped_path, result.stderr)

    def test_checks_credentials_and_private_paths_in_large_generated_bundles(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            token = synthetic_bot_token()
            private_path = private_home_path()
            bundle = "x" * (11 * 10**5) + f"\nconst token = '{token}'; const path = '{private_path}'\n"
            write_plugin(root, "dist/scripts/telegram-launcher.js", bundle)
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/dist/scripts/telegram-launcher.js: bot-credential", result.stderr)
            self.assertIn("plugins/telegram-channel/dist/scripts/telegram-launcher.js: private-home-path", result.stderr)
            self.assertNotIn(token, result.stderr)
            self.assertNotIn(private_path, result.stderr)

    def test_allows_dependency_numeric_constants_only_in_reviewed_generated_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            max_value = str(2**32 - 1)
            write_plugin(root, "dist/scripts/telegram-launcher.js", f"const max = {max_value}\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_long_numeric_id_in_an_unreviewed_dist_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            fixture_id = "".join(("765", "4321"))
            write_plugin(root, "dist/unreviewed.js", f"const telegramUserId = {fixture_id}\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/dist/unreviewed.js: unapproved-long-numeric-id", result.stderr)

    def test_rejects_long_numeric_id_in_a_test_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fixture_id = "".join(("765", "4321"))
            write_plugin(root, "adapter.test.ts", f"const telegramUserId = {fixture_id}\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/adapter.test.ts: unapproved-long-numeric-id", result.stderr)

    def test_rejects_underscore_grouped_long_numeric_id_in_a_test_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fixture_id = "_".join(("765", "4321"))
            write_plugin(root, "adapter.test.ts", f"const telegramUserId = {fixture_id}\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/adapter.test.ts: unapproved-long-numeric-id", result.stderr)

    def test_rejects_short_unapproved_username(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            username = "@" + "xy"
            write_plugin(root, "adapter.test.ts", f"const operator = '{username}'\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/adapter.test.ts: unapproved-username", result.stderr)

    def test_rejects_non_regular_artifacts_without_opening_them(self) -> None:
        if not hasattr(os, "mkfifo"):
            self.skipTest("named pipes are unavailable")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            fifo = root / "plugins" / "telegram-channel" / "untrusted-pipe"
            os.mkfifo(fifo)
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("plugins/telegram-channel/untrusted-pipe: non-regular-artifact", result.stderr)

    def test_checks_scanner_source_and_test_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            write_plugin(root, "safe.ts")
            token = synthetic_bot_token()
            private_path = private_home_path()
            write_root_file(root, "scripts/verify-public-source.py", f"const value = '{token}'\n")
            write_root_file(root, "scripts/verify-public-source.test.py", f"const path = '{private_path}'\n")
            result = self.run_checker(root)
            self.assertEqual(result.returncode, 1)
            self.assertIn("scripts/verify-public-source.py: bot-credential", result.stderr)
            self.assertIn("scripts/verify-public-source.test.py: private-home-path", result.stderr)
            self.assertNotIn(token, result.stderr)
            self.assertNotIn(private_path, result.stderr)


if __name__ == "__main__":
    unittest.main()
