"""Deterministic watcher/progress tests; no Linux desktop or real transfer needed."""
import ast
from pathlib import Path
import struct
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))


def helper_functions(*names):
    # Execute the actual helper definitions with fake OS/time boundaries, also
    # on hosts without Linux's pwd/grp/inotify. No duplicate watcher algorithm.
    constants = {"PROGRESS_INTERVAL", "WATCH_NAME_LIMIT", "EVENT_FMT", "EVENT_SIZE", "IN_Q_OVERFLOW"}
    nodes = [node for node in TREE.body if (
        isinstance(node, ast.FunctionDef) and node.name in names) or (
        isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets))]
    namespace = {"struct": struct}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class WatcherTests(unittest.TestCase):
    def watch(self, batches):
        ns = helper_functions("inotify_loop")
        clock = [0.0]
        messages = []
        stopped = [False]
        handle = SimpleNamespace(fd=11, wd=-1, req_id=7, path_bytes=b"/dest",
                                 stop_event=SimpleNamespace(is_set=lambda: stopped[0]))
        batches = iter(batches)
        chunks = []

        def select(*args):
            clock[0] += 0.05
            self.assertLess(clock[0], 2, "watcher failed to flush its bounded debounce window")
            batch = next(batches, None)
            if batch is None:
                return [], [], []
            chunks.append(batch)
            return [11], [], []

        def emit(msg):
            messages.append(msg)
            stopped[0] = True

        ns.update(
            os=SimpleNamespace(read=lambda *_: chunks.pop(0), close=Mock()),
            select=SimpleNamespace(select=select), time=SimpleNamespace(monotonic=lambda: clock[0]),
            to_str=lambda value: value.decode(), emit=emit,
        )
        ns["inotify_loop"](handle)
        ns["os"].close.assert_called_once_with(11)
        self.assertEqual(len(messages), 1)
        return messages[0]

    @staticmethod
    def event(name=b"", mask=0x100):
        raw = name + b"\0" if name else b""
        return struct.pack("iIII", 1, mask, 0, len(raw)) + raw

    def test_named_changes_are_coalesced_and_deduplicated(self):
        msg = self.watch([self.event(b"b") + self.event(b"a"), self.event(b"b")])
        self.assertEqual(msg["names"], ["a", "b"])
        self.assertFalse(msg["dirty"])

    def test_exact_limit_stays_incremental(self):
        msg = self.watch([b"".join(self.event(str(i).encode()) for i in range(200))])
        self.assertEqual(len(msg["names"]), 200)
        self.assertFalse(msg["dirty"])

    def test_burst_becomes_one_dirty_flag_without_retaining_names(self):
        msg = self.watch([b"".join(self.event(str(i).encode()) for i in range(1000)), self.event(b"later")])
        self.assertEqual(msg["names"], [])
        self.assertTrue(msg["dirty"])

    def test_overflow_and_directory_self_events_are_not_lost(self):
        for mask in (0x4000, 0x400, 0x800):
            with self.subTest(mask=mask):
                msg = self.watch([self.event(b"before"), self.event(mask=mask) + self.event(b"after")])
                self.assertEqual(msg["names"], [])
                self.assertTrue(msg["dirty"])


class ArchiveProgressTests(unittest.TestCase):
    def archive(self, cancel=False):
        ns = helper_functions("run_bsdtar")
        clock = [0.0]
        chunks = iter([b"x file.txt\n"] * 12 + [b""])
        proc = Mock(pid=42, returncode=0)
        proc.stderr.fileno.return_value = 10
        proc.poll.return_value = 0
        messages = []
        measure = Mock(return_value=300)
        kill = Mock()

        def select(*args):
            clock[0] += 0.1
            return [10], [], []

        ns.update(
            subprocess=SimpleNamespace(Popen=Mock(return_value=proc), PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL),
            os=SimpleNamespace(read=lambda *_: next(chunks)), select=SimpleNamespace(select=select),
            time=SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda _: None),
            trusted_env=lambda: {}, emit=lambda msg: messages.append((clock[0], msg)),
            kill_process_group=kill, MAX_CAPTURE_BYTES=65536,
        )
        event = SimpleNamespace(is_set=lambda: cancel and clock[0] >= 0.3)
        result = ns["run_bsdtar"](["bsdtar"], 7, event, 1000, measure)
        proc.stderr.close.assert_called_once()
        return result, messages, measure, kill

    def test_archive_progress_uses_two_hz_absolute_snapshots(self):
        result, messages, measure, kill = self.archive()
        self.assertEqual(result, (0, ""))
        self.assertEqual(len(messages), 2)
        self.assertEqual(measure.call_count, 2)
        for i, (when, msg) in enumerate(messages):
            self.assertEqual(msg["bytes"], 300, "absolute bytes, not deltas")
            self.assertEqual(msg["total"], 1000)
            self.assertGreater(msg["files"], 0)
            if i:
                self.assertGreaterEqual(when - messages[i - 1][0], 0.5)
        kill.assert_not_called()

    def test_cancel_still_checks_faster_than_the_progress_interval(self):
        result, messages, measure, kill = self.archive(cancel=True)
        self.assertEqual(result, (-1, "cancelled"))
        self.assertEqual(messages, [])
        measure.assert_not_called()
        kill.assert_called_once()


class CopyProgressTests(unittest.TestCase):
    def test_copy_throttle_preserves_absolute_values_and_forced_final_snapshot(self):
        ns = helper_functions()
        operation = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "op_copy_move")
        progress = next(node for node in operation.body if isinstance(node, ast.FunctionDef) and node.name == "emit_progress")
        exec(compile(ast.Module(body=[progress], type_ignores=[]), str(SOURCE), "exec"), ns)
        clock = [0.5]
        messages = []
        ns.update(time=SimpleNamespace(monotonic=lambda: clock[0]), last_progress=[0.0], start_time=0.0,
                  bytes_done=[50], total_bytes=100, files_done=[1], total_files=2, req_id=7, emit=messages.append)
        ns["emit_progress"]("first.txt")
        clock[0] = 0.75
        ns["bytes_done"][0] = 75
        ns["emit_progress"]("second.txt")
        self.assertEqual(len(messages), 1)
        clock[0] = 1.0
        ns["bytes_done"][0] = 100
        ns["files_done"][0] = 2
        ns["emit_progress"]("second.txt")
        clock[0] = 1.01
        ns["emit_progress"]("", force=True)
        self.assertEqual([m["bytes"] for m in messages], [50, 100, 100])
        self.assertEqual(messages[-1]["files"], 2)
        self.assertEqual(messages[-1]["total"], 100)
        self.assertEqual(messages[-1]["current"], "")


if __name__ == "__main__":
    unittest.main()
