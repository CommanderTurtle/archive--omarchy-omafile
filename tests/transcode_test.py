import errno
import importlib.machinery
import importlib.util
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import Mock, patch


class TranscodeTests(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
        spec = importlib.util.spec_from_loader(
            "transcode_helper", importlib.machinery.SourceFileLoader("transcode_helper", str(path)))
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.messages = []
        self.helper.emit = self.messages.append
        self.wrapper = "/home/me/.local/share/omarchy/bin/omarchy-launch-floating-terminal-with-presentation"
        self.binary = "/home/me/Omarchy install/bin/omarchy-transcode"
        self.which = self.enterContext(patch.object(
            self.helper.shutil, "which", side_effect=[self.wrapper, self.binary]))
        self.isfile = self.enterContext(patch.object(self.helper.os.path, "isfile", return_value=True))
        self.Popen = self.enterContext(patch.object(self.helper.subprocess, "Popen", return_value=Mock()))

    def call(self, paths):
        self.helper.op_transcode({"id": 1, "op": "transcode", "paths": paths})
        return self.messages[-1]

    def test_single_file_uses_native_prompts_and_detached_session_environment(self):
        path = "/home/me/a 'quoted' $(touch nope); photo.avif"
        self.assertEqual(self.call([path]), {"id": 1, "t": "done", "launched": 1})
        argv = self.Popen.call_args.args[0]
        self.assertEqual(argv[0], self.wrapper)
        self.assertEqual(shlex.split(argv[1]), [self.binary, path])
        self.assertEqual(self.Popen.call_args.kwargs, {
            "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL, "close_fds": True, "start_new_session": True,
        })
        self.assertNotIn("outputs", self.messages[-1])

    def test_mixed_selection_is_deduplicated_and_sequential(self):
        paths = ["/home/me/photo.avif", "/home/me/a'; $(nope).webm"]
        self.assertEqual(self.call(paths + paths), {"id": 1, "t": "done", "launched": 2})
        self.Popen.assert_called_once()
        expected = []
        for path in paths:
            expected.extend(["printf", "%s\n", "Transcoding " + path, "&&",
                             self.binary, path, "||", "true", ";"])
        lexer = shlex.shlex(self.Popen.call_args.args[0][1], posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        self.assertEqual(list(lexer), expected[:-1])

    def test_invalid_paths_do_not_launch(self):
        for paths in (None, [], "photo.avif", ["relative.avif"], ["/tmp/bad\0.avif"], [None]):
            with self.subTest(paths=paths):
                self.assertEqual(self.call(paths)["code"], "EINVAL")
        self.Popen.assert_not_called()

    def test_missing_files_do_not_launch(self):
        self.isfile.return_value = False
        self.assertEqual(self.call(["/tmp/missing.avif"])["code"], "ENOENT")
        self.Popen.assert_not_called()

    def test_missing_commands_are_named(self):
        for missing in ("omarchy-launch-floating-terminal-with-presentation", "omarchy-transcode"):
            with self.subTest(missing=missing):
                self.which.side_effect = lambda name: None if name == missing else self.wrapper
                result = self.call(["/tmp/photo.avif"])
                self.assertEqual(result["code"], "EUNSUPPORTED")
                self.assertIn(missing, result["message"])
        self.Popen.assert_not_called()

    def test_launch_failure_is_not_reported_as_success(self):
        self.Popen.side_effect = OSError(errno.EACCES, "permission denied")
        self.assertEqual(self.call(["/tmp/photo.avif"])["code"], "EACCES")


if __name__ == "__main__":
    unittest.main()
