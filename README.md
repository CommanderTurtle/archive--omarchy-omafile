## personal fork of chr0nzz's omafile

| choice | notes |
|---|---|
| bare-metal previewer | every image preview is decoded on demand — no per-image cache, one zoom rate, one pan position that's never rewritten. No ffprobe wait, no electron-style lag |
| transcode, fork style | the upstream bin patch path with unified webp + avif codecs, batch convert from the context menu (video → mp4/gif, image → jpg/png/webp/avif), progress in the transfer bar |
| share any file as a link | ln.kr (https://github.com/CommanderTurtle/ln.kr) / linkoder (https://github.com/CommanderTurtle/linkoder): zero uploads, hashtag code built by the browser's JS, no backend — doubles as a markdown/mermaid previewer |
| omp + zed | agent: omp, editor: zeditor — menu buttons wired to your harness and editor; the change from issue #50 (https://github.com/chr0nzz/omarchy-omafile/issues/50), upstreamed as a setting in v1.4.3 |
| multi-select open | opening a multi-highlighted selection opens all of them, not just the one under the cursor; the "Open with" enter double-open is also fixed |

```bash
omarchy plugin add https://github.com/CommanderTurtle/archive--omarchy-omafile.git --enable --yes
```

### [chr0nzz/omarchy-omafile](https://github.com/chr0nzz/omarchy-omafile) - visit for the upstream repo!
