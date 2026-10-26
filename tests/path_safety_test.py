import errno
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


def load_helper():
    path = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
    spec = importlib.util.spec_from_loader("path_safety", importlib.machinery.SourceFileLoader("path_safety", str(path)))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


class Capture:
    def __init__(self, helper):
        self.helper = helper
        self.done = []
        self.errors = []
        self.emitted = []

    def __enter__(self):
        self.patches = [
            patch.object(self.helper, "send_done", side_effect=lambda req_id, **kw: self.done.append(kw)),
            patch.object(self.helper, "send_error",
                         side_effect=lambda req_id, code, msg, path=None: self.errors.append(code)),
            patch.object(self.helper, "emit", side_effect=self.emitted.append),
        ]
        for p in self.patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self.patches:
            p.stop()


class PathSafetyTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_home = self.root / "data"
        self.env = patch.dict(os.environ, {"XDG_DATA_HOME": str(self.data_home)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def share_with_link(self):
        private = self.root / "private"
        private.mkdir()
        (private / "keep.txt").write_text("keep")
        share = self.root / "share"
        share.mkdir()
        os.symlink(private, share / "docs")
        return private, share

    def untrusted_links(self):
        share = os.fsencode(self.root / "share")
        return patch.object(self.helper, "mount_entries", return_value=[(b"/", "ext4"), (share, "nfs4")])

    def test_rename_never_replaces_an_existing_file(self):
        (self.root / "a.txt").write_text("a")
        (self.root / "b.txt").write_text("b")
        with Capture(self.helper) as cap:
            self.helper.op_rename({"id": 1, "path": str(self.root / "a.txt"), "newName": "b.txt"})
        self.assertEqual(cap.errors, ["EEXIST"])
        self.assertEqual((self.root / "b.txt").read_text(), "b")
        self.assertEqual((self.root / "a.txt").read_text(), "a")

    def test_rename_refuses_names_that_leave_the_folder(self):
        (self.root / "a.txt").write_text("a")
        for bad in ("..", ".", "x/y", ""):
            with Capture(self.helper) as cap:
                self.helper.op_rename({"id": 1, "path": str(self.root / "a.txt"), "newName": bad})
            self.assertEqual(cap.errors, ["EINVAL"], bad)
        self.assertTrue((self.root / "a.txt").exists())

    def test_a_link_on_a_network_share_is_not_followed_for_delete(self):
        private, share = self.share_with_link()
        with self.untrusted_links(), Capture(self.helper) as cap:
            self.helper.op_delete({"id": 1, "paths": [str(share / "docs" / "keep.txt")]})
        self.assertFalse(cap.done[0]["results"][0]["ok"])
        self.assertTrue((private / "keep.txt").exists())

    def test_a_link_on_a_network_share_is_not_followed_for_trash_rename_or_chmod(self):
        private, share = self.share_with_link()
        target = str(share / "docs" / "keep.txt")
        with self.untrusted_links(), Capture(self.helper) as cap:
            self.helper.op_trash({"id": 1, "paths": [target]})
            self.helper.op_rename({"id": 2, "path": target, "newName": "moved.txt"})
            self.helper.op_chmod({"id": 3, "path": target, "set": 0o777, "clear": 0})
            self.helper.op_mkdir({"id": 4, "path": str(share / "docs" / "new")})
        self.assertFalse(cap.done[0]["results"][0]["ok"])
        self.assertEqual(cap.errors, ["ELOOP", "ELOOP", "ELOOP"])
        self.assertTrue((private / "keep.txt").exists())
        self.assertFalse((private / "new").exists())
        self.assertNotEqual(stat.S_IMODE(os.stat(private / "keep.txt").st_mode), 0o777)

    def test_local_links_owned_by_the_user_still_work(self):
        private, share = self.share_with_link()
        with Capture(self.helper) as cap:
            self.helper.op_rename({"id": 1, "path": str(share / "docs" / "keep.txt"), "newName": "kept.txt"})
        self.assertEqual(cap.errors, [])
        self.assertTrue((private / "kept.txt").exists())

    def private_picture_behind_a_shared_leaf(self):
        private = self.root / "private"
        private.mkdir()
        photo = private / "secret.png"
        photo.write_bytes(self.helper.PNG_MAGIC + b"\0" * 64)
        share = self.root / "share"
        share.mkdir()
        os.symlink(photo, share / "holiday.png")
        return share

    def transcode(self, path):
        programs = {"magick": "/usr/bin/magick", "ffmpeg": None, "cjxl": None}
        ran = []

        def encode(argv, fds, *rest, **kw):
            ran.append(argv)
            os.write(fds[1], b"converted")
            return 0, None

        with patch.object(self.helper, "run_media", side_effect=encode):
            try:
                self.helper.transcode_one(str(path), "jpg", "original", programs, threading.Event())
            except OSError as e:
                return e.errno, ran
        return None, ran

    def test_transcode_will_not_read_through_a_link_swapped_into_a_network_share(self):
        share = self.private_picture_behind_a_shared_leaf()
        with self.untrusted_links():
            code, ran = self.transcode(share / "holiday.png")
        self.assertEqual(code, errno.ELOOP)
        self.assertEqual(ran, [], "the encoder never sees the private picture")
        self.assertEqual(sorted(p.name for p in share.iterdir()), ["holiday.png"])

    def test_transcode_will_not_read_through_a_link_someone_else_owns(self):
        share = self.private_picture_behind_a_shared_leaf()
        with patch.object(self.helper, "link_trusted", return_value=False):
            code, ran = self.transcode(share / "holiday.png")
        self.assertEqual(code, errno.ELOOP)
        self.assertEqual(ran, [])
        self.assertEqual(sorted(p.name for p in share.iterdir()), ["holiday.png"])

    def test_transcode_never_follows_the_leaf_once_resolved(self):
        share = self.private_picture_behind_a_shared_leaf()
        real = share / "real.png"
        real.write_bytes(self.helper.PNG_MAGIC + b"\0" * 64)
        swapped = []
        original = self.helper.resolve_trusted_leaf

        def swap_after_resolving(path_bytes):
            resolved = original(path_bytes)
            os.unlink(real)
            os.symlink(self.root / "private" / "secret.png", real)
            swapped.append(resolved)
            return resolved

        with patch.object(self.helper, "resolve_trusted_leaf", side_effect=swap_after_resolving):
            code, ran = self.transcode(real)
        self.assertEqual(len(swapped), 1)
        self.assertEqual(code, errno.ELOOP)
        self.assertEqual(ran, [])

    def test_transcode_through_a_trusted_local_link_still_works(self):
        share = self.private_picture_behind_a_shared_leaf()
        code, ran = self.transcode(share / "holiday.png")
        self.assertIsNone(code)
        self.assertEqual(len(ran), 1)
        self.assertEqual((share / "holiday-original.jpg").read_bytes(), b"converted")

    def test_recursive_chmod_stays_inside_the_tree(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret").write_text("x")
        os.chmod(outside / "secret", 0o600)
        tree = self.root / "tree"
        (tree / "sub").mkdir(parents=True)
        (tree / "sub" / "file").write_text("x")
        os.chmod(tree / "sub" / "file", 0o600)
        os.symlink(outside, tree / "sub" / "link")
        with Capture(self.helper) as cap:
            self.helper.op_chmod({"id": 1, "path": str(tree), "set": 0o044, "clear": 0, "recursive": True})
        self.assertEqual(cap.errors, [])
        self.assertEqual(stat.S_IMODE(os.stat(tree / "sub" / "file").st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(os.stat(outside / "secret").st_mode), 0o600)

    def trash(self, path):
        with Capture(self.helper) as cap:
            self.helper.op_trash({"id": 1, "paths": [str(path)]})
        self.assertTrue(cap.done[0]["results"][0]["ok"], cap.done)
        return cap.done[0]["results"][0]["trashinfo"]

    def test_restore_never_replaces_a_file_that_came_back(self):
        target = self.root / "note.txt"
        target.write_text("old")
        name = self.trash(target)
        target.write_text("new")
        with Capture(self.helper) as cap:
            self.helper.op_restore({"id": 2, "items": [name]})
        self.assertFalse(cap.done[0]["results"][0]["ok"])
        self.assertEqual(target.read_text(), "new")
        self.assertTrue((self.data_home / "Trash" / "files" / name).exists())

    def test_trash_names_never_collide(self):
        first = self.root / "a" / "same.txt"
        second = self.root / "b" / "same.txt"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_text("1")
        second.write_text("2")
        names = [self.trash(first), self.trash(second)]
        self.assertEqual(len(set(names)), 2)
        files = self.data_home / "Trash" / "files"
        self.assertEqual(sorted((files / n).read_text() for n in names), ["1", "2"])

    def test_restore_refuses_paths_that_climb_out(self):
        files_fd = os.open(self.root, os.O_PATH)
        try:
            with patch.object(self.helper, "mount_point_for_fd", return_value=b"/mnt/usb"):
                self.assertIsNone(self.helper.restore_target("../home/me/.bashrc", files_fd, False))
                self.assertIsNone(self.helper.restore_target("/home/me/.bashrc", files_fd, False))
                self.assertIsNone(self.helper.restore_target("a/../../b", files_fd, True))
                self.assertEqual(self.helper.restore_target("docs/a.txt", files_fd, False), b"/mnt/usb/docs/a.txt")
                self.assertEqual(self.helper.restore_target("/home/me/a.txt", files_fd, True), b"/home/me/a.txt")
        finally:
            os.close(files_fd)

    def test_the_trash_summary_does_not_send_items(self):
        target = self.root / "t.txt"
        target.write_text("data")
        self.trash(target)
        with Capture(self.helper) as cap:
            self.helper.op_trashinfo({"id": 1})
        self.assertNotIn("items", cap.emitted[0])
        self.assertEqual(cap.emitted[0]["count"], 1)
        self.assertEqual(cap.emitted[0]["bytes"], 4)

    def test_peek_refuses_a_fifo_without_blocking(self):
        os.mkfifo(self.root / "song.txt")
        result = {}
        with Capture(self.helper) as cap:
            worker = threading.Thread(target=self.helper.op_peek, args=({"id": 1, "path": str(self.root / "song.txt")},), daemon=True)
            worker.start()
            worker.join(5)
            self.assertFalse(worker.is_alive(), "peek blocked on a fifo")
            result["errors"] = cap.errors
        self.assertEqual(result["errors"], ["EINVAL"])

    def test_copy_refuses_dot_and_dotdot_sources(self):
        dest = self.root / "dest"
        dest.mkdir()
        with Capture(self.helper) as cap:
            self.helper.op_copy_move({"id": 1, "sources": [str(self.root) + "/..", str(self.root) + "/."], "dest": str(dest)},
                                     threading.Event(), False)
        self.assertEqual(len(cap.done[0]["errors"]), 2)
        self.assertEqual(os.listdir(dest), [])

    def test_listing_stops_at_the_entry_limit(self):
        for i in range(5):
            (self.root / ("f%d" % i)).write_text("")
        self.helper.LIST_LIMIT = 3
        with Capture(self.helper) as cap:
            self.helper.op_list({"id": 1, "path": str(self.root)}, threading.Event())
        self.assertTrue(cap.done[0]["truncated"])
        self.assertEqual(cap.done[0]["total"], 3)


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()

    def test_a_running_request_id_cannot_be_reused(self):
        self.assertIsNotNone(self.helper.register_inflight(7, "copy"))
        self.assertIsNone(self.helper.register_inflight(7, "copy"))
        self.helper.unregister_inflight(7)
        self.assertIsNotNone(self.helper.register_inflight(7, "copy"))

    def test_a_stale_conflict_answer_is_ignored(self):
        ev = threading.Event()
        with self.helper.CONFLICT_LOCK:
            self.helper.PENDING_CONFLICTS[3] = {"event": ev, "action": None, "applyAll": False, "seq": 5}
        self.helper.op_resolve({"id": 3, "action": "overwrite", "seq": 4})
        self.assertFalse(ev.is_set())
        self.helper.op_resolve({"id": 3, "action": "overwrite"})
        self.assertFalse(ev.is_set())
        self.helper.op_resolve({"id": 3, "action": "skip", "seq": 5})
        self.assertTrue(ev.is_set())
        self.assertEqual(self.helper.PENDING_CONFLICTS[3]["action"], "skip")

    def test_every_request_line_runs_exactly_once(self):
        seen = []
        lock = threading.Lock()

        def record(req):
            with lock:
                seen.append(req["id"])

        with patch.object(self.helper, "dispatch", side_effect=record):
            for i in range(200):
                self.helper.handle_line(b'{"id": %d, "op": "ping"}\n' % i)
            deadline = time.monotonic() + 5
            while len(seen) < 200 and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(sorted(seen), list(range(200)))

    def test_a_raw_lone_surrogate_round_trips_to_the_original_byte(self):
        got = []
        with patch.object(self.helper, "dispatch", side_effect=got.append):
            self.helper.handle_line(b'{"id": 1, "op": "stat", "path": "/tmp/\xed\xb3\xbf"}\n')
            deadline = time.monotonic() + 5
            while not got and time.monotonic() < deadline:
                time.sleep(0.01)
        self.assertEqual(self.helper.to_bytes(got[0]["path"]), b"/tmp/\xff")

    def test_a_hung_mount_does_not_pile_up_threads(self):
        release = threading.Event()
        real = os.statvfs

        def slow(path):
            if path == b"/hung":
                release.wait(10)
                raise OSError(errno.EIO, "gone")
            return real(path)

        self.helper.SPACE_TIMEOUT = 0.3
        try:
            with patch.object(self.helper.os, "statvfs", side_effect=slow):
                first = self.helper.guarded_space(["/", "/hung"])
                second = self.helper.guarded_space(["/", "/hung"])
                self.assertIn("/", first)
                self.assertNotIn("/hung", first)
                self.assertNotIn("/hung", second)
                hung = [t for t in threading.enumerate() if t is self.helper.SPACE_PENDING.get("/hung")]
                self.assertEqual(len(hung), 1)
        finally:
            release.set()


if __name__ == "__main__":
    unittest.main()
