# Inferno

**Inferno** is the stack. This repository holds **`inferno-service`**, its
service layer: a local service that wraps yt-dlp behind an HTTP + WebSocket API,
built to [SPEC.md](SPEC.md).

It runs standalone today and is designed to be spawned as a sidecar process by
the Inferno desktop app (Tauri) later — which is the reason for the rule below.

> **Wiring it into the desktop app?** Read
> [TAURI_INTEGRATION.md](TAURI_INTEGRATION.md) first — bundling, spawning,
> lifecycle, CORS, settings, the progress model and the error codes.

Every capability is exposed through the API. The bundled CLI and web client are
ordinary consumers of it with no privileged path — anything they can do, a
third-party tool can do with the same public endpoints. When the desktop app
arrives it gets no special access either; it is one more API client.

`/health` and the websocket `hello` frame both report
`{"service": "inferno-service", "product": "inferno"}`, so anything that finds
the port knows what answered.

---

## Quick start

```bash
python -m venv .venv
.venv/Scripts/activate          # POSIX: source .venv/bin/activate
pip install -e ".[dev]"

python -m inferno_service --check   # what resolved, and from where
python -m inferno_service           # serve on http://127.0.0.1:8765
```

Then open <http://127.0.0.1:8765/> for the test client, or
<http://127.0.0.1:8765/docs> for the API docs.

```bash
inferno-cli health
inferno-cli formats "https://www.youtube.com/watch?v=..."
inferno-cli download "https://www.youtube.com/watch?v=..." --quality 1080p
```

## Running the tests

```bash
pytest                       # the whole hermetic suite, ~6 seconds
pytest -q --tb=short         # quieter
pytest tests/test_options.py # just the SPEC §7 rules
```

The suite never touches the network and never runs a real binary. It swaps the
single yt-dlp seam (`inferno_service.ytdlp.build_ydl`) for a fake that drives the
*real* progress hooks, postprocessor hooks and exceptions, so the whole stack —
options resolution, the thread bridge, the event bus, the websockets, the file
routes — runs end to end and deterministically.

To also check the wiring against the real thing:

```bash
INFERNO_LIVE=1 pytest -m live              # real yt-dlp, real network
INFERNO_LIVE=1 INFERNO_LIVE_DOWNLOAD=1 pytest -m live   # real bytes
```

Live tests skip rather than fail when a binary is missing or the upstream site
refuses, so they stay useful without becoming noise.

## External binaries

The code is the easy part; shipping the binaries is where the time goes. The
resolver contract is identical for every binary:

```
env override  ->  bundled directory  ->  PATH
```

`/health` reports which one won, so a packaging mistake shows up as
`"source": "path"` on a dev machine instead of hiding until a clean install.

Populate the bundled tree like this — three files, exact names in
[vendor/README.md](vendor/README.md):

```
vendor/
  ffmpeg/
    ffmpeg.exe        (or ffmpeg)    <- gyan.dev, ffmpeg-release-essentials
    ffprobe.exe       (or ffprobe)   <- must sit beside ffmpeg, plain name
  js/
    qjs.exe           (or qjs)       <- quickjs-ng qjs-windows-x86_64.exe, renamed
```

**ffprobe must keep its plain name beside ffmpeg.** yt-dlp derives ffprobe's
location from ffmpeg's directory. This is also why Tauri's `externalBin` sidecar
mechanism does not work here: it renames binaries to
`ffmpeg-x86_64-pc-windows-msvc.exe` and leaves ffprobe unfindable. Ship the
directory as a bundle resource and pass its path in `FFMPEG_DIR` instead.

**A JavaScript runtime is not optional for YouTube.** Without one, extraction
silently degrades and formats go missing. The service passes QuickJS to yt-dlp
as the dict `{"quickjs": {"path": ...}}` — the library option, not the CLI's
`RUNTIME:PATH` string. `python -m inferno_service --check` tells you if it
resolved; `pytest -m live` includes a test that catches the silent-degradation
case by asserting adaptive formats come back.

**PO tokens are a design constraint, not a bug.** Without one, YouTube caps
un-tokened media downloads: a single ranged request above roughly 512 KiB is
refused and a chunked download stops after about 0.7 MB. No client-side chunk
tuning fixes it. Set `COOKIES_FROM_BROWSER` or `COOKIE_FILE`; when the cap bites
anyway the service reports `po_token_required` rather than a bare 403.

## Settings

Every setting is declared exactly once, in `SETTINGS` in
[config.py](inferno_service/config.py). The env parser, the config file, the
REST API, the UI metadata and the generated TypeScript are all derived from that
table, so adding a setting is one row and nothing can drift.

**Three layers, with provenance.** The effective value is
`default → file → env`, and the service always reports which layer won. A
setting pinned by an environment variable comes back as `source: "env"` and
`locked_by_env: true`, so a settings screen greys the control out instead of
silently discarding what the user typed.

**Two scopes.** `service` settings configure the process. `download` settings
are the defaults a new job inherits, so a client can `POST {"url": "..."}` and
still get the user's chosen quality. Only fields a client explicitly sends
override them.

```
GET   /api/v1/settings     values + download_defaults + schema + groups
PATCH /api/v1/settings     {"values": {"downloads.max_concurrent": 4}}
                           {"reset": ["media.quality"]}   // [] resets all
```

Changes apply **live**: concurrency resizes without interrupting running
downloads, and the download folder, cookies, proxy, ffmpeg paths and cache TTL
are all re-read. Only `server.api_token`, `server.cors_origins` and
`events.history` need a restart, and the response says so in `restart_required`.
Every change is broadcast as a `settings.changed` event, so other clients
converge without polling.

Settings persist to `INFERNO_CONFIG_FILE` (default `./inferno-settings.json`),
written atomically. A corrupt file is reported and ignored rather than fatal; a
bad **environment** value fails loudly at startup, because that is an operator
mistake rather than user data.

### Environment variables

Every service setting still has one, exactly as SPEC §9 specifies. See
`.env.example`.

| Variable | Key | Default | |
| --- | --- | --- | --- |
| `DOWNLOAD_DIR` | `downloads.directory` | `./downloads` | one subdirectory per job id |
| `MAX_CONCURRENT` | `downloads.max_concurrent` | `2` | downloads at once; the rest queue |
| `JOB_TTL` | `downloads.job_ttl` | `86400` | seconds a finished job is retained |
| `EVENT_HISTORY` | `events.history` | `250` | events buffered per channel for replay |
| `PROGRESS_INTERVAL` | `events.progress_interval` | `0.25` | min seconds between progress events |
| `INFO_CACHE_TTL` | `metadata.cache_ttl` | `300` | metadata cache; `0` disables |
| `API_TOKEN` | `server.api_token` | — | if set, every request must carry it |
| `CORS_ORIGINS` | `server.cors_origins` | `*` | comma-separated |
| `SERVE_FILES` | `server.serve_files` | `true` | false when something else serves the output |
| `FFMPEG_DIR` | `binaries.ffmpeg_dir` | — | directory or binary path; overrides the search |
| `JS_RUNTIME_DIR` | `binaries.js_runtime_dir` | — | directory or binary path |
| `COOKIES_FROM_BROWSER` | `privacy.cookies_from_browser` | — | `firefox`, `chrome`, … |
| `COOKIE_FILE` | `privacy.cookie_file` | — | Netscape cookie file |
| `HTTP_CHUNK_SIZE` | `network.http_chunk_size` | `262144` | forces ranged GETs; `0` disables |
| `RETRIES` | `network.retries` | `10` | beyond SPEC §9 |
| `PROXY` | `network.proxy` | — | beyond SPEC §9 |
| `INFERNO_CONFIG_FILE` | — | `./inferno-settings.json` | where settings persist |

### Generated TypeScript

```bash
python -m inferno_service --emit-typescript path/to/inferno-settings.ts
```

Emits `ServiceSettings`, `DownloadDefaults`, `SettingKey`, `SETTINGS_DEFAULTS`
and `SETTINGS_SCHEMA` — choice settings as literal unions, nullable settings as
`| null`, typechecking under `--strict`. Because the schema carries labels,
groups, ranges and units, a settings screen can be generated from it rather than
hand-built.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | capabilities, versions, job counts |
| `GET` | `/api/v1/settings` | effective settings, schema, and where each came from |
| `PATCH` | `/api/v1/settings` | change settings; applies live where it can |
| `GET`/`POST` | `/api/v1/info` | normalised metadata for a URL |
| `GET` | `/api/v1/formats` | format table only, for a quality picker |
| `GET` | `/api/v1/subtitles` | caption track listing; fetches nothing |
| `POST` | `/api/v1/downloads` | queue a job, returns `202` + job object |
| `GET` | `/api/v1/downloads` | list jobs; `?status=`, `?limit=` |
| `GET` | `/api/v1/downloads/{id}` | one job |
| `POST` | `/api/v1/downloads/{id}/cancel` | cancel a running or queued job |
| `DELETE` | `/api/v1/downloads/{id}` | cancel and remove files; `?keep_files=true` |
| `GET` | `/api/v1/downloads/{id}/files/{name}` | fetch a finished file (supports `Range`) |
| `WS` | `/ws/downloads/{id}` | one job |
| `WS` | `/ws/events` | firehose across all jobs |

Auth, when enabled, is `X-API-Key: <token>` or `?token=<token>`. The query form
exists because browser WebSocket clients cannot set headers, and it works on
REST too for consistency.

### Sending intent, not internals

Clients describe what they want; the server resolves it into yt-dlp options in
exactly one function ([options.py](inferno_service/options.py)):

```jsonc
POST /api/v1/downloads
{
  "url": "https://...",
  "mode": "audio",          // or "video"
  "quality": "1080p",       // ignored when mode is audio
  "audio_format": "mp3",
  "container": "mp4",       // ignored when mode is audio
  "format_id": null         // escape hatch; must be compatible with mode
}
```

1. `mode: "audio"` produces an audio-only selector. `quality` and `container`
   are ignored, and a merged `a+b` selector is never produced.
2. `mode: "video"` produces a height-capped selector from `quality`.
3. An explicit `format_id` wins **only if it is compatible with `mode`**. A
   merged `a+b` id with `mode: "audio"` is a `400 format_mode_conflict`,
   rejected at the boundary rather than failing deep inside yt-dlp.

The job object echoes back the **resolved** options, including the format
selector the server actually chose, so integrators can debug without reading the
source. `options.requested` carries what was sent, for comparison.

### WebSocket protocol

Every frame, without exception:

```json
{ "type": "progress", "job_id": "a1b2", "ts": 1756400000.12, "seq": 42, "data": {} }
```

`seq` is monotonic per server. Reconnect with `?since=<seq>` and you miss
nothing; if the ring buffer already discarded what you asked for, the first
frame (`hello` or `job.snapshot`) says so via `data.replay_truncated`. Per-socket
frames — `hello`, `job.snapshot`, `heartbeat`, `pong` — carry the current `seq`
without advancing it, so resuming from one lands in the right place.

Client-to-server is deliberately minimal: `{"type": "ping"}` answered with
`{"type": "pong"}`. REST is the canonical path for actions, so there is exactly
one way to cancel a job.

`progress` percent restarts between streams on a merge — video reaches 100%,
then audio begins again at 0. Tell them apart by `format_id`.

### Presenting progress: three stages

That per-stream percent is the raw truth, and rendering it directly gives a
progress bar that fills twice. Presentation is the client's job, so both bundled
clients collapse the stream into **three stages**:

| Stage | Statuses | Bar |
| --- | --- | --- |
| 1. preparing | `queued`, `extracting` | indeterminate |
| 2. downloading | `downloading` | determinate |
| 3. processing | `postprocessing` | indeterminate |

Stages 1 and 3 are deliberately indeterminate: extraction has no measurable
total, and ffmpeg reports no percentage at all, so inventing one would be a lie.

Stage 2 is weighted **by stream, not by bytes**. Each expected stream owns an
equal slice of the bar, so on a merge the video pass fills 0–50% and the audio
pass fills 50–100%. How many streams to expect comes from the job's own
`options.merging`, and a high-water mark makes going backwards impossible even
if that expectation turns out wrong.

Byte-weighting is the obvious alternative and it does not work, because the
total is unknowable until the last stream starts. Measured on a real 360p
YouTube download, the video stream was 15.3 MB and the audio stream 10.2 MB — so
a byte-weighted bar reaches 99.9% on the video pass and then drops to 60% when
the audio pass reveals the real total. Bytes are still shown in the text beside
the bar, where a revised figure costs nothing.

`DownloadProgress` in [cli.py](inferno_service/clients/cli.py) is the reference
implementation, and the web client mirrors it exactly. A third-party client
needs only `format_id`, `downloaded_bytes` and `total_bytes` from each `progress`
frame, plus `options.merging` from the job.

### Errors

One envelope, always:

```json
{ "error": { "code": "po_token_required", "message": "…", "detail": {} } }
```

Codes: `invalid_url`, `unsupported_site`, `video_unavailable`,
`format_unavailable`, `format_mode_conflict`, `po_token_required`,
`ffmpeg_missing`, `js_runtime_missing`, `network_error`, `disk_error`,
`job_not_found`, `cancelled`.

Four codes exist beyond the spec's table because the boundary needs them:
`invalid_request` (malformed body or unknown field), `unauthorized`,
`file_not_found` / `file_serving_disabled` (the file route), `not_found` /
`method_not_allowed` (framework-level failures, so even an unknown path answers
with the envelope) and `internal_error` (an unclassified crash).

Everything preflightable is preflighted. A job asking for mp3 output with no
ffmpeg resolved fails immediately with `ffmpeg_missing` — it does not download
200 MB first and fail in postprocessing.

## Layout

| Module | Responsibility |
| --- | --- |
| [main.py](inferno_service/main.py) | FastAPI surface: REST routes, websockets, auth, CORS |
| [jobs.py](inferno_service/jobs.py) | Job registry, concurrency cap, execution, cancellation |
| [events.py](inferno_service/events.py) | Thread-to-loop bridge, envelope, per-channel replay buffer |
| [extract.py](inferno_service/extract.py) | Metadata fetch and normalisation, short-TTL cache |
| [options.py](inferno_service/options.py) | Request intent to yt-dlp options. Single source of truth |
| [binaries.py](inferno_service/binaries.py) | Locate ffmpeg/ffprobe and the JS runtime; report what resolved |
| [config.py](inferno_service/config.py) | Env-driven settings |
| [schemas.py](inferno_service/schemas.py) | Pydantic request/response models |
| [errors.py](inferno_service/errors.py) | Stable codes, the one envelope, yt-dlp exception classification |
| [ytdlp.py](inferno_service/ytdlp.py) | The single seam to the yt-dlp library |

`errors.py` and `ytdlp.py` are additions to the spec's module table. The first
keeps the code-classification logic in one place instead of scattering it across
routes and jobs; the second is what makes the hermetic test suite possible.

**Threading.** yt-dlp is blocking and reports progress on its own worker thread;
websocket clients live on the asyncio event loop. That boundary is crossed in
exactly one place — `EventBus.run_on_loop` in `events.py`. Job state mutation
goes through it too, so no other module thinks about threads.

**Cancellation.** A per-job `threading.Event`, checked in the progress hook on
every tick, which unwinds yt-dlp through its own cancellation exception. Cancel
bites mid-download, not merely between jobs.

## Not in v1

Multi-user accounts (one optional shared token instead), job history surviving a
restart, distributed workers, a polished UI. State is in-memory and the server is
single-process; if that stops being fine, SQLite is the next step and the seams
are the job registry and the event buffer.
