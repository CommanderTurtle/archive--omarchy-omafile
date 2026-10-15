import importlib.machinery
import importlib.util
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
import wave
import zlib
from unittest.mock import patch


def load_helper():
    path = Path(__file__).resolve().parents[1] / "bin" / "omafile-helper"
    spec = importlib.util.spec_from_loader("media_safety", importlib.machinery.SourceFileLoader("media_safety", str(path)))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)


def png(width=1, height=1, extra=b""):
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + extra
            + chunk(b"IDAT", zlib.compress(b"\0" * (width * 4 + 1) * height)) + chunk(b"IEND", b""))


BOMB = chunk(b"zTXt", b"comment\0\0" + zlib.compress(b"A" * 2000000))


class ThumbnailChunkTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()

    def test_written_thumbnails_keep_only_pixel_data(self):
        chunks = self.helper.png_chunks(png(extra=BOMB + chunk(b"iTXt", b"x\0\0\0\0\0y") + chunk(b"eXIf", b"z" * 100)))
        out = self.helper.png_chunks(self.helper.png_with_text(chunks, {"Thumb::URI": "file:///a"}))
        kinds = [kind for kind, _ in out]
        self.assertEqual(kinds, [b"IHDR", b"tEXt", b"IDAT", b"IEND"])

    def test_a_cached_thumbnail_with_extra_metadata_is_not_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            uri = "file:///a.png"
            text = chunk(b"tEXt", b"Thumb::URI\0" + uri.encode()) + chunk(b"tEXt", b"Thumb::MTime\0" + b"5")
            good = os.path.join(tmp, "good.png")
            bad = os.path.join(tmp, "bad.png")
            huge = os.path.join(tmp, "huge.png")
            Path(good).write_bytes(png(extra=text))
            Path(bad).write_bytes(png(extra=text + BOMB))
            Path(huge).write_bytes(png(width=4096, height=1, extra=text))
            self.assertTrue(self.helper.thumb_matches(good, uri, 5))
            self.assertFalse(self.helper.thumb_matches(bad, uri, 5))
            self.assertFalse(self.helper.thumb_matches(huge, uri, 5))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg is not installed")
class AudioPreviewTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"XDG_CACHE_HOME": str(self.root / "cache")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def run_op(self, path):
        result = {}
        with patch.object(self.helper, "send_done", side_effect=lambda req_id, **kw: result.update(kw)), \
                patch.object(self.helper, "send_error", side_effect=lambda req_id, code, msg, path=None: result.update(code=code)):
            self.helper.op_audiopreview({"id": 1, "path": str(path)}, threading.Event())
        return result

    def song_with_cover(self):
        tone = self.root / "tone.wav"
        with wave.open(str(tone), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(8000)
            out.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i / 8000 * 2 * math.pi * 440))) for i in range(8000)))
        cover = self.root / "cover.png"
        cover.write_bytes(png(extra=BOMB))
        song = self.root / "song.mp3"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(tone), "-i", str(cover), "-map", "0", "-map", "1",
                        "-c:a", "libmp3lame", "-c:v", "copy", "-disposition:v", "attached_pic",
                        "-metadata", "title=" + "T" * 1000, "-metadata", "artist=Me", str(song)], check=True)
        return song

    def test_the_shell_gets_audio_without_cover_art_or_tags(self):
        result = self.run_op(self.song_with_cover())
        self.assertNotIn("code", result, result)
        streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0",
                                  result["path"]], capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(streams, ["audio"])
        self.assertEqual(len(result["title"]), self.helper.AUDIO_TAG_LIMIT)
        self.assertEqual(result["artist"], "Me")
        self.assertEqual(os.stat(result["path"]).st_mode & 0o777, 0o600)

    def test_only_the_latest_preview_copies_are_kept(self):
        song = self.song_with_cover()
        paths = [self.run_op(song)["path"] for _ in range(3)]
        left = sorted(os.listdir(os.path.dirname(paths[0])))
        self.assertLessEqual(len(left), 2)
        self.assertIn(os.path.basename(paths[-1]), left)

    def test_a_fifo_is_refused_without_blocking(self):
        fifo = self.root / "song.mp3"
        os.mkfifo(fifo)
        self.assertEqual(self.run_op(fifo).get("code"), "EINVAL")


if __name__ == "__main__":
    unittest.main()
