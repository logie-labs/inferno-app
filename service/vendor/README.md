# Bundled binaries

Three files. The resolver looks here after `FFMPEG_DIR` / `JS_RUNTIME_DIR` and
before `PATH`. Run `python -m inferno_service --check` to see which source won —
it exits non-zero and names anything unresolved.

```
vendor/
  ffmpeg/
    ffmpeg.exe     (ffmpeg on macOS/Linux)
    ffprobe.exe    (ffprobe)
  js/
    qjs.exe        (qjs)      -- QuickJS, ~2 MB
```

## Where to download

**ffmpeg + ffprobe (Windows)** — <https://www.gyan.dev/ffmpeg/builds/>

| File | Notes |
| --- | --- |
| `ffmpeg-release-essentials.7z` | ~33 MB packed. Stable release, everything this service needs. |
| `ffmpeg-release-essentials.zip` | ~106 MB packed, same contents, no 7-Zip needed. |
| `ffmpeg-git-essentials.7z` | Git master, if you want the newest extractor fixes. |

All variants are 64-bit and static, so `ffmpeg.exe` and `ffprobe.exe` are
self-contained. Take those two out of `bin/` inside the archive and drop them in
`vendor/ffmpeg/`. Ignore `ffplay.exe`.

Other platforms: <https://johnvansickle.com/ffmpeg/> (Linux static builds), or
`brew install ffmpeg` (macOS) and copy the two binaries out of the Homebrew
prefix.

**QuickJS** — <https://github.com/quickjs-ng/quickjs/releases/latest>

Download `qjs-windows-x86_64.exe` and **rename it to `qjs.exe`** in
`vendor/js/`. (There is a 32-bit `qjs-windows-x86.exe` and a `qjsc-*` compiler
alongside it; you want neither.) On macOS/Linux the equivalent assets are
`qjs-darwin-*` and `qjs-linux-*`, renamed to `qjs`.

Use **quickjs-ng**, not Bellard's original QuickJS — it is the fork that ships
prebuilt binaries and the one yt-dlp targets.

## Two rules that are easy to get wrong

**ffprobe keeps its plain name, beside ffmpeg.** yt-dlp derives ffprobe's
location from ffmpeg's directory. Rename it or move it elsewhere and yt-dlp will
not find it even though `/health` still reports it as available — the resolver
flags exactly that case with a warning in `ffprobe.error`. This is also why
Tauri's `externalBin` mechanism does not work here: it renames binaries to
`ffmpeg-x86_64-pc-windows-msvc.exe`. Ship this directory as a bundle resource
and pass its path in `FFMPEG_DIR` instead.

**The JS runtime is not optional for YouTube.** Without it, extraction degrades
silently — adaptive (video-only and audio-only) formats simply go missing rather
than raising an error, so you get a working-looking service that can only fetch
low-quality muxed streams. `pytest -m live` includes a test that catches this by
asserting adaptive formats come back.

## Not committed

`.gitignore` excludes the binaries themselves; only this file and the `.gitkeep`
placeholders are tracked. They are large (the ffmpeg static builds are ~115 MB
each) and platform-specific.
