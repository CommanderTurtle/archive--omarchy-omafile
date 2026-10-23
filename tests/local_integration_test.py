"""Host-only contract tests; execute the real helper functions, not Linux I/O."""
import ast
import os
import re
import stat
import struct
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import zlib
from unittest.mock import Mock, patch


def helper():
    tree = ast.parse((Path(__file__).resolve().parents[1] / 'bin/omafile-helper').read_text(encoding='utf8'))
    names = {'op_transcode', 'transcode_output_path', 'op_lnkrclipboard',
             'preview_side', 'thumb_place', 'preview_root', 'png_read_limit', 'prune_previews',
             'png_chunk', 'png_chunks', 'png_scan', 'png_size', 'png_text', 'safe_thumb',
             'copy_png_chunk', 'write_png_from', 'private_makedirs', 'image_dimensions'}
    assignments = {'TRANSCODE_FORMATS', 'TRANSCODE_QUALITIES', 'TRANSCODE_RESOLUTIONS',
                   'THUMB_BUCKETS', 'THUMB_BUCKET_SIZES', 'THUMB_MAX_READ', 'THUMB_MAX_SIDE',
                   'THUMB_TEXT_LIMIT', 'PNG_MAGIC', 'PIXEL_CHUNKS', 'PNG_SMALL_CHUNK',
                   'PREVIEW_KEEP', 'PREVIEW_CACHE_BYTES'}
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names
             or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in assignments for t in n.targets)]
    env = dict(os=os, subprocess=subprocess, tempfile=tempfile, time=time, re=re,
               struct=struct, stat=stat, zlib=zlib, HOME=os.path.expanduser('~'),
               trusted_program=lambda n: '/usr/bin/' + n, trusted_env=lambda: {},
               kill_process_group=Mock(), emit=Mock(), send_done=Mock(), send_error=Mock())
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'omafile-helper', 'exec'), env)
    return env


class IntegrationContracts(unittest.TestCase):
    def test_cli_output_names_for_each_axis_and_native_reencode(self):
        output = helper()['transcode_output_path']
        for name, fmt, quality, resolution, expected in [
            ('a.png', 'webp', 'high', '', 'a-high.webp'),
            ('a.png', '', '', '2160', 'a-2160.png'),
            ('a.jpeg', '', '', '2160', 'a-2160.jpg'),
            ('a.mp4', 'mp4', '', '', 'a-re.mp4'),
            ('a.webm', 'mp4', 'high', '720', 'a-720.mp4'),
            ('a.heic', '', '', '2160', ''),
        ]:
            with self.subTest(name=name, fmt=fmt, quality=quality, resolution=resolution):
                self.assertEqual(output(name, fmt, quality, resolution), expected)

    def test_native_cli_receives_exact_four_positions_and_file_backed_stdio(self):
        h = helper()
        process = Mock(returncode=0)
        process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'photo ; literal.png'; source.touch()
            result = Path(folder) / 'photo ; literal-high.webp'; result.touch()
            with patch.object(subprocess, 'Popen', return_value=process) as launch:
                h['op_transcode']({'id': 1, 'paths': [str(source)], 'format': 'webp', 'quality': 'high'}, threading.Event())
            self.assertEqual(launch.call_args.args[0], ['/usr/bin/omarchy-transcode', str(source), 'webp', 'high', ''])
            self.assertNotEqual(launch.call_args.kwargs['stdout'], subprocess.PIPE)
            self.assertIs(launch.call_args.kwargs['stdout'], launch.call_args.kwargs['stderr'])
            h['send_done'].assert_called_once_with(1, outputs=[str(result)], files=1)

    def test_cancel_kills_only_the_launched_group_and_cleans_diagnostics(self):
        h = helper(); process = Mock(returncode=None); process.poll.return_value = None
        event = Mock(); event.is_set.side_effect = [False]; event.wait.return_value = True
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'photo.png'; source.touch()
            original_mkstemp = tempfile.mkstemp
            with patch.object(tempfile, 'mkstemp', side_effect=lambda **kw: original_mkstemp(dir=folder, **kw)), \
                 patch.object(subprocess, 'Popen', return_value=process):
                h['op_transcode']({'id': 1, 'paths': [str(source)], 'format': 'webp'}, event)
            self.assertFalse(any(p.name.startswith('.omafile-transcode-') for p in Path(folder).iterdir()))
        self.assertGreaterEqual(h['kill_process_group'].call_count, 1)
        self.assertEqual(h['send_error'].call_args.args[1], 'ECANCELED')
        h['send_done'].assert_not_called()

    def test_clipboard_failure_does_not_report_success(self):
        h = helper()
        with patch.object(subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'wl-copy')):
            h['op_lnkrclipboard']({'id': 1, 'text': 'hello'})
        h['send_done'].assert_not_called()
        self.assertEqual(h['send_error'].call_args.args[1], 'EINTERNAL')

    def test_original_size_includes_8192_and_larger_without_changing_shared_thumbnails(self):
        h = helper()
        for side in (2048, 4096, 7680, 8192, 16384):
            folder, got, limit = h['thumb_place']('/cache/thumbnails', 'preview-' + str(side))
            self.assertEqual(got, side)
            self.assertGreaterEqual(limit, side * side * 8)
            self.assertEqual(os.path.basename(folder), str(side))
        self.assertEqual(h['thumb_place']('/cache', 'xx-large')[1], 1024)
        h['run_tool'] = lambda argv: {'streams': [{'width': 8192, 'height': 8192}]}
        self.assertEqual(h['image_dimensions']('/photo.png'), (8192, 8192))

    def test_upstream_streamed_sanitizer_never_loads_idat_and_strips_metadata(self):
        h = helper()
        chunk = h['png_chunk']
        pixels = zlib.compress(b'\0' * 100)
        raw = (h['PNG_MAGIC'] + chunk(b'IHDR', struct.pack('>IIBBBBB', 8192, 8192, 8, 6, 0, 0, 0))
               + chunk(b'eXIf', b'private metadata') + chunk(b'IDAT', pixels) + chunk(b'IEND', b''))
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'input.png'; source.write_bytes(raw)
            result = Path(folder) / 'clean.png'
            with source.open('rb') as stream:
                chunks = h['png_scan'](stream, h['png_read_limit'](8192))
                self.assertEqual(next(c[1] for c in chunks if c[0] == b'IDAT'), b'')
                h['write_png_from'](str(result), stream, chunks, {})
            cleaned = h['png_chunks'](result.read_bytes())
            self.assertEqual([c[0] for c in cleaned], [b'IHDR', b'IDAT', b'IEND'])
            self.assertTrue(h['safe_thumb'](cleaned, 8192))
            self.assertEqual(h['png_size'](cleaned), (8192, 8192))
            self.assertEqual(cleaned[1][1], pixels)

    def test_upstream_preview_cache_keeps_newest_and_obeys_byte_budget(self):
        h = helper()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / '8192').mkdir(); (root / 'unrelated').mkdir()
            (root / 'unrelated' / 'keep.png').touch()
            for i in range(3):
                p = root / '8192' / (str(i) + '.png'); p.write_bytes(b'x' * 100)
                os.utime(p, (1000 + i, 1000 + i))
            h['prune_previews'](folder, keep=10, budget=250)
            self.assertEqual(sorted(p.name for p in (root / '8192').iterdir()), ['1.png', '2.png'])
            self.assertTrue((root / 'unrelated' / 'keep.png').exists())


if __name__ == '__main__':
    unittest.main()
