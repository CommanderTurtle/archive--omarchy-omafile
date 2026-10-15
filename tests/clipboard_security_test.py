import importlib.machinery
import importlib.util
from pathlib import Path
import time
import unittest
from unittest.mock import patch


class ClipboardSecurityTests(unittest.TestCase):
    def load_helper(self):
        path = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
        spec = importlib.util.spec_from_loader("clipboard_security", importlib.machinery.SourceFileLoader("clipboard_security", str(path)))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        return helper

    def test_clipboard_uses_trusted_lookup_and_environment(self):
        helper = self.load_helper()
        with patch.object(helper, "trusted_program", return_value="/usr/bin/printf") as lookup, \
                patch.object(helper, "trusted_env", return_value={"PATH": "/usr/bin:/bin"}) as env:
            self.assertEqual(helper.wl_paste(["image/png"]), b"image/png")
            lookup.assert_called_once_with("wl-paste")
            env.assert_called()

    def test_oversized_clipboard_data_is_refused(self):
        helper = self.load_helper()
        with patch.object(helper, "trusted_program", return_value="/usr/bin/head"):
            self.assertIsNone(helper.wl_paste(["-c", "5000", "/dev/zero"], limit=4096))
            self.assertEqual(len(helper.wl_paste(["-c", "4096", "/dev/zero"], limit=4096)), 4096)

    def test_an_endless_clipboard_owner_times_out(self):
        helper = self.load_helper()
        helper.CLIP_TIMEOUT = 1.0
        started = time.monotonic()
        with patch.object(helper, "trusted_program", return_value="/usr/bin/cat"):
            self.assertIsNone(helper.wl_paste(["/dev/zero"], limit=4096))
        self.assertLess(time.monotonic() - started, 5)

    def test_field_paste_reads_bounded_text(self):
        helper = self.load_helper()
        sent = {}
        answers = {"--list-types": b"TARGETS\ntext/plain;charset=utf-8\n"}

        def fake(args, limit=0):
            if args == ["--list-types"]:
                return answers["--list-types"]
            self.assertEqual(args, ["--no-newline", "--type", "text/plain;charset=utf-8"])
            self.assertEqual(limit, helper.CLIP_TEXT_LIMIT)
            return answers.get("text")

        with patch.object(helper, "wl_paste", side_effect=fake), \
                patch.object(helper, "send_done", side_effect=lambda req_id, **kw: sent.update(kw)), \
                patch.object(helper, "send_error", side_effect=lambda req_id, code, msg, path=None: sent.update(code=code)):
            answers["text"] = b"hello"
            helper.op_cliptext({"id": 1})
            self.assertEqual(sent, {"text": "hello"})
            sent.clear()
            answers["text"] = None
            helper.op_cliptext({"id": 2})
            self.assertEqual(sent, {"code": "E2BIG"})

    def test_clipboard_file_lists_are_capped(self):
        helper = self.load_helper()
        sent = {}
        listing = "\n".join("file:///tmp/f%d" % i for i in range(helper.CLIP_PATH_LIMIT + 1)).encode()

        def fake(args, limit=0):
            return b"text/uri-list" if args == ["--list-types"] else listing

        with patch.object(helper, "wl_paste", side_effect=fake), \
                patch.object(helper, "send_done", side_effect=lambda req_id, **kw: sent.update(kw)), \
                patch.object(helper, "send_error", side_effect=lambda req_id, code, msg, path=None: sent.update(code=code)):
            helper.op_clipget({"id": 1})
        self.assertEqual(sent, {"code": "E2BIG"})

    def test_untrusted_clipboard_program_is_not_started(self):
        helper = self.load_helper()
        with patch.object(helper, "trusted_program", side_effect=FileNotFoundError), \
                patch.object(helper.subprocess, "run") as run:
            self.assertIsNone(helper.wl_paste(["--list-types"]))
            run.assert_not_called()
