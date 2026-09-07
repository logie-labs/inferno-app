<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Inferno service (the download backend)

None of the downloading is implemented in the frontend. It lives in a Python
service under `service/`, which this app spawns as a sidecar and talks to over
HTTP + WebSocket.

- **Source:** `service/` — its own package, with its own tests.
- **Read first:** [`service/TAURI_INTEGRATION.md`](service/TAURI_INTEGRATION.md).
  It covers bundling, spawning, lifecycle, CORS, the settings system, the
  progress model and the error codes. Do not start wiring without it.
- **Contract:** [`service/SPEC.md`](service/SPEC.md).

Four things that are easy to get wrong and are explained there in full:

1. **The app gets no privileged path.** Call the service's public API over
   `fetch` from the frontend. Do not proxy REST through Tauri commands, and do
   not add backdoor commands — SPEC calls that a design bug.
2. **ffmpeg/ffprobe must ship as bundle `resources`, never `externalBin`.**
   `externalBin` renames binaries; yt-dlp finds ffprobe by looking beside
   ffmpeg, so renaming breaks every merge.
3. **Pass only bootstrap env when spawning** (`INFERNO_CONFIG_FILE`,
   `API_TOKEN`, `FFMPEG_DIR`, `JS_RUNTIME_DIR`, `CORS_ORIGINS`). Any other env
   var *pins* that setting and makes the matching control in the settings screen
   read-only.
4. **Do not render `progress.percent` directly.** yt-dlp reports per stream, so
   a merge fills the bar twice. Port `DownloadProgress` from the service's
   `clients/cli.py`.

Settings types are generated, not hand-written:

```bash
python -m inferno_service --emit-typescript lib/inferno-settings.ts
```
