import importlib.machinery
import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch


def load_helper():
    path = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
    spec = importlib.util.spec_from_loader("trash_security", importlib.machinery.SourceFileLoader("trash_security", str(path)))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def info_body(path):
    return "[Trash Info]\nPath=" + path + "\nDeletionDate=2026-10-12T12:00:00\n"


class TrashSecurityTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.tmp = tempfile.TemporaryDirectory()
        self.files = Path(self.tmp.name) / "files"
        self.info = Path(self.tmp.name) / "info"
        self.files.mkdir()
        self.info.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def roots(self):
        return [(os.fsencode(self.files), os.fsencode(self.info))]

    def add_good(self, name):
        (self.files / name).write_text("kept")
        (self.info / (name + ".trashinfo")).write_text(info_body(str(Path(self.tmp.name) / "restored" / name)))

    def read_without_hanging(self, path):
        result = {}
        worker = threading.Thread(target=lambda: result.update(raw=self.helper.read_trashinfo(os.fsencode(path))), daemon=True)
        worker.start()
        worker.join(5)
        self.assertFalse(worker.is_alive(), "reading " + str(path) + " blocked")
        return result["raw"]

    def test_a_normal_trashinfo_is_read(self):
        self.add_good("note.txt")
        raw = self.read_without_hanging(self.info / "note.txt.trashinfo")
        self.assertIn("Path=", raw)

    def test_an_oversized_trashinfo_is_refused(self):
        (self.info / "big.trashinfo").write_bytes(b"x" * (self.helper.TRASHINFO_LIMIT + 1))
        self.assertIsNone(self.read_without_hanging(self.info / "big.trashinfo"))

    def test_a_huge_sparse_trashinfo_is_refused_without_reading_it(self):
        with open(self.info / "sparse.trashinfo", "wb") as f:
            f.truncate(1 << 34)
        with patch.object(self.helper.os, "read", side_effect=AssertionError("read an oversized file")):
            self.assertIsNone(self.read_without_hanging(self.info / "sparse.trashinfo"))

    def test_a_fifo_trashinfo_does_not_block(self):
        os.mkfifo(self.info / "pipe.trashinfo")
        self.assertIsNone(self.read_without_hanging(self.info / "pipe.trashinfo"))

    def test_a_symlinked_trashinfo_is_not_followed(self):
        os.symlink("/dev/zero", self.info / "zero.trashinfo")
        self.assertIsNone(self.read_without_hanging(self.info / "zero.trashinfo"))

    def test_the_trash_listing_skips_bad_metadata_and_keeps_the_rest(self):
        self.add_good("keep.txt")
        (self.info / "big.trashinfo").write_bytes(b"Path=/x\n" + b"x" * self.helper.TRASHINFO_LIMIT)
        os.mkfifo(self.info / "pipe.trashinfo")
        os.symlink("/dev/zero", self.info / "zero.trashinfo")
        sent = []
        with patch.object(self.helper, "list_trash_roots", return_value=self.roots()), \
                patch.object(self.helper, "emit", side_effect=sent.append), \
                patch.object(self.helper, "send_done"):
            worker = threading.Thread(target=self.helper.op_trashinfo, args=({"id": 1, "items": True},), daemon=True)
            worker.start()
            worker.join(5)
            self.assertFalse(worker.is_alive(), "the trash listing blocked")
        self.assertEqual([item["name"] for item in sent[0]["items"]], ["keep.txt"])
        self.assertEqual(sent[0]["count"], 1)

    def test_restore_refuses_oversized_metadata(self):
        (self.files / "big").write_text("kept")
        (self.info / "big.trashinfo").write_bytes(b"Path=/tmp/x\n" + b"x" * self.helper.TRASHINFO_LIMIT)
        done = {}
        with patch.object(self.helper, "list_trash_roots", return_value=self.roots()), \
                patch.object(self.helper, "send_done", side_effect=lambda req_id, **kw: done.update(kw)):
            self.helper.op_restore({"id": 2, "items": ["big"]})
        self.assertEqual(done["results"], [{"path": "big", "ok": False, "message": "invalid trashinfo"}])
        self.assertTrue((self.files / "big").exists())

    def test_restore_still_works_for_normal_metadata(self):
        self.add_good("back.txt")
        done = {}
        with patch.object(self.helper, "list_trash_roots", return_value=self.roots()), \
                patch.object(self.helper, "send_done", side_effect=lambda req_id, **kw: done.update(kw)):
            self.helper.op_restore({"id": 3, "items": ["back.txt"]})
        self.assertTrue(done["results"][0]["ok"], done["results"])
        self.assertTrue((Path(self.tmp.name) / "restored" / "back.txt").exists())


if __name__ == "__main__":
    unittest.main()
