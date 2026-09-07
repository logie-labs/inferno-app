# Inferno

A desktop downloader for video and audio, built on
[yt-dlp](https://github.com/yt-dlp/yt-dlp).

Inferno is a Tauri app with a Next.js interface, in front of a local Python
service that does the actual downloading. The three pieces talk over a plain
HTTP + WebSocket API — the same one a CLI or any other client can use, with no
privileged path reserved for the app.

> **Status:** early. It is built and tested on Windows; the shell carries macOS
> and Linux code paths, but nothing has been verified there.

## What it does

- **A real queue.** Concurrent downloads with live per-job progress, retries,
  cancellation, and a library of everything that has finished.
- **Video and audio.** Quality and container for video, format, bitrate,
  metadata and cover art for audio extraction.
- **Filename templates.** `{title} [{id}]` and friends, with a live preview and
  a case style.
- **Spotify local files.** Delivers finished audio into a Spotify local-files
  folder, detected from the install rather than typed in by hand.
- **Soundpad.** Sends finished audio to Soundpad over its remote-control API.
- **A command palette,** with every command rebindable.
- **Update checking** for the app and for the yt-dlp inside it — see below.

## Requirements

| | |
| --- | --- |
| Node.js | 20+ |
| Rust | 1.77.2+, with the [Tauri prerequisites](https://tauri.app/start/prerequisites/) |
| Python | 3.11+ — only needed to build the bundled service |

## Getting started

```bash
npm install
npm run dev          # Tauri shell + Next dev server
```

`npm run dev` spawns the service from source, so it needs the Python side set
up once:

```bash
python -m venv service/.venv
service/.venv/Scripts/pip install -e "service[dev]"
```

To drive the interface in an ordinary browser instead — useful for UI work —
run the service by hand and point the web build at it:

```bash
python -m inferno_service     # serves on http://127.0.0.1:8765
npm run dev:web               # http://localhost:3000
```

### The vendored binaries

The service resolves `ffmpeg`, `ffprobe` and a JS runtime in the order
`environment variable → bundled → PATH`. The bundled copies live in
`service/vendor/` and are **gitignored**, because they are large and
platform-specific — a fresh clone has an empty `vendor/`.

[`service/vendor/README.md`](service/vendor/README.md) says which three files
to download and where to put them. `python -m inferno_service --check` reports
which source won for each one, and exits non-zero if anything is unresolved.

## Building an installer

```bash
service/.venv/Scripts/pip install pyinstaller
npm run tauri:build
```

That freezes the service with PyInstaller, verifies it actually serves
`/health`, and then builds the Tauri bundle around it. The build refuses to
produce an installer whose vendored binaries are missing, because that failure
would otherwise only appear on somebody else's machine.

## Layout

```
app/          Next.js routes - the shell is one page
components/   UI, and one directory per section (downloads, library, settings)
lib/          Client-side logic: the service client, settings, updates, Spotify
src-tauri/    The Rust shell: window, service supervision, file and DB addons
service/      inferno-service - the Python download backend, with its own tests
```

Two documents are worth reading before changing how the app and the service fit
together: [`service/SPEC.md`](service/SPEC.md) for the API contract, and
[`service/TAURI_INTEGRATION.md`](service/TAURI_INTEGRATION.md) for bundling,
spawning and lifecycle.

## Updates

Settings → Updates checks the whole install: the app, the service, yt-dlp, and
the media tools. The app's own version is compared against the releases
published in this repository; yt-dlp is compared against
[its own releases](https://github.com/yt-dlp/yt-dlp/releases), because a stale
yt-dlp is the usual reason downloads stop working.

Everything sealed into the installer is folded away in that screen — updating
the app updates all of it at once. Checking is a plain unauthenticated request
to the GitHub API, and can be turned off entirely.

Releases are tagged `vMAJOR.MINOR.PATCH`. The version the app reports comes
from `src-tauri/tauri.conf.json`, so a release tag and that file have to agree.

## Responsible use

Inferno is a front end for yt-dlp. Whether a particular download is permitted
is determined by the site's terms and by the copyright in the material, not by
this tool — please use it for content you have the right to download.

## License

[MIT](LICENSE).

yt-dlp, ffmpeg and the other bundled binaries carry their own licenses, which
apply to any installer you distribute.
