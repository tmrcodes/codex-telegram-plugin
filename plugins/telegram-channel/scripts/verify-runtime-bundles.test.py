#!/usr/bin/env python3
"""Focused checks for the runtime bundle publish-set verifier."""

from __future__ import annotations

import runpy
import tempfile
import unittest
from pathlib import Path


ENTRIES = runpy.run_path(str(Path(__file__).with_name("verify-runtime-bundles.py")))["entries"]


class RuntimeBundleVerifierTests(unittest.TestCase):
    def test_rejects_symlinks_in_the_publish_set(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "regular.js").write_text("safe\n", encoding="utf-8")
            (root / "linked.js").symlink_to("regular.js")
            with self.assertRaisesRegex(ValueError, "runtime bundle has a symlink"):
                ENTRIES(root)

    def test_includes_empty_directories_in_the_exact_entry_set(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "empty").mkdir()
            self.assertEqual(ENTRIES(root), {"empty/": None})


if __name__ == "__main__":
    unittest.main()
