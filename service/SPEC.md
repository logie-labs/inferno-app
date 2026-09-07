# yt-dlp Service — Build Spec

A local service that wraps yt-dlp behind an HTTP + WebSocket API.

Every capability is exposed through that API. The bundled CLI and web client are
ordinary consumers of it with no privileged path — anything they can do, a
third-party tool can do with the same public endpoints. Treat "this feature
needs an internal shortcut" as a design bug, not a shortcut.

Runs standalone today; later spawned as a sidecar process by a Tauri desktop
app. Assume both from the start.

---

## 1. Principles

1. **API-first, no back doors.** First-party clients get no special access.
2. **Raw values.** Bytes are integers, timestamps are epoch or ISO-8601, codecs
   are as reported upstream. No display formatting server-side — presentation is
   the client's job.
3. **Machine-readable errors.** Every failure carries a stable `code`. A client
   must never have to parse English prose to react correctly.
4. **One event envelope.** All websocket frames share a single shape. New events
   add `type` values; they never introduce a new frame shape.
5. **Lossless streams.** Every event carries a monotonic `seq`. A client
   reconnects with `?since=<seq>` and misses nothing.
6. **Self-describing.** `/health` reports real capabilities — which binaries
   resolved, which features are available, what the limits are — so a client
   adapts instead of guessing. OpenAPI at `/openapi.json`, docs at `/docs`.
7. **The server owns policy.** Format selection, defaults, and validation live
   server-side. Clients send *intent*, not yt-dlp internals.

## 2. Non-goals (v1)

- Multi-user accounts or per-user permissions. One optional shared token.
- Job history surviving a restart (in-memory; see §12 if that changes).
- Distributed or multi-process workers.
- A polished UI. Ship a minimal test client only.

---

## 3. Architecture

| Module | Responsibility |
| --- | --- |
| `main.py` | FastAPI surface: REST routes, websocket endpoints, auth, CORS |
| `jobs.py` | Job registry, concurrency cap, yt-dlp execution, cancellation |
| `events.py` | Thread to event-loop bridge, envelope, per-channel replay buffer |
| `extract.py` | Metadata fetch and normalisation, short-TTL cache |
| `options.py` | Request intent to yt-dlp options. Single source of truth |
| `binaries.py` | Locate ffmpeg/ffprobe and the JS runtime; report what resolved |
| `config.py` | Env-driven settings |
| `schemas.py` | Pydantic request/response models |

**Threading model.** yt-dlp is blocking and reports progress through callbacks
on its own worker thread; websocket clients live on the asyncio event loop.
Cross that boundary in exactly one place (`events.py`, via
`loop.call_soon_threadsafe`). No other module should think about threads.

**Cancellation.** A per-job `threading.Event`, checked in the progress hook,
which unwinds yt-dlp through its cancellation exception. Cancel must be
responsive mid-download, not merely between jobs.

---

## 4. REST API

All routes under `/api/v1` except `/health`. Auth, when enabled, is
`X-API-Key: <token>` or `?token=<token>` — the query form exists because browser
WebSocket clients cannot set headers, and it is supported on REST too for
consistency.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | capabilities, versions, job counts — see §8 |
| `GET`/`POST` | `/api/v1/info` | normalised metadata for a URL |
| `GET` | `/api/v1/formats` | format table only, for a quality picker |
| `GET` | `/api/v1/subtitles` | caption track listing; fetches nothing |
| `POST` | `/api/v1/downloads` | queue a job, returns `202` + job object |
| `GET` | `/api/v1/downloads` | list jobs; `?status=`, `?limit=` |
| `GET` | `/api/v1/downloads/{id}` | one job |
| `POST` | `/api/v1/downloads/{id}/cancel` | cancel a running or queued job |
| `DELETE` | `/api/v1/downloads/{id}` | cancel and remove files; `?keep_files=true` |
| `GET` | `/api/v1/downloads/{id}/files/{name}` | fetch a finished file |

Notes that matter for third-party tooling:

- **File serving stays in the API.** A remote tool cannot read the output
  directory. Support HTTP `Range` on the file route so clients can resume.
- **Reject unknown request fields** (`extra="forbid"`). A typo in someone's
  integration should fail loudly at the boundary, not be silently ignored.
- **`POST /downloads` returns immediately** with the job object and a `ws_url`.
  It never blocks on the download.

---

## 5. WebSocket protocol

- `/ws/downloads/{job_id}` — one job
- `/ws/events` — firehose across all jobs

Both accept `?token=` and `?since=<seq>`.

Every frame, without exception:

```json
{ "type": "progress", "job_id": "a1b2", "ts": 1756400000.12, "seq": 42,
  "data": {} }
```

`seq` is monotonic per server. On connect, replay any buffered events newer than
`since`, then stream live. The buffer is bounded per channel; if `since` is
older than the buffer, say so in the first frame rather than silently skipping
events (`data.replay_truncated: true`).

| type | when |
| --- | --- |
| `job.snapshot` | first frame on a job socket — full current state |
| `hello` | first frame on the firehose — version, capabilities, recent jobs |
| `job.queued` / `job.extracting` / `job.downloading` / `job.postprocessing` | state changes |
| `progress` | download tick, throttled to roughly 4/sec |
| `progress.finished` | one stream finished; fires twice for a video+audio merge |
| `postprocessor` | an ffmpeg stage started or finished |
| `log` | yt-dlp's own output, with `level` |
| `job.completed` / `job.failed` / `job.cancelled` | terminal; `data.files` on success |
| `heartbeat` | every 25s idle, so proxies do not close the socket |

`progress.data`: `status`, `downloaded_bytes`, `total_bytes`,
`total_bytes_estimate`, `percent`, `speed` (B/s), `eta` (s), `elapsed`,
`fragment_index`, `fragment_count`, `filename`, `format_id`, `ext`.

Percent restarts between streams on a merge — video reaches 100%, then audio
begins again at 0. Clients tell them apart by `format_id`.

**Client to server** is deliberately minimal: `{"type": "ping"}` answered with
`{"type": "pong"}`. REST is the canonical path for actions, so there is exactly
one way to cancel a job.

---

## 6. Job lifecycle

```
queued -> extracting -> downloading -> postprocessing -> completed
                     -> failed
                     -> cancelled
```

Terminal states: `completed`, `failed`, `cancelled`. A job object carries
`job_id`, `url`, `status`, `options`, `video`, `progress`, `files`, `error`,
`created_at`, `started_at`, `finished_at`, `elapsed`.

Echo back **resolved** options, not the ones sent. When a client asks for
`mode: "audio"` it should be able to see the format selector the server actually
chose — that is how integrators debug without reading the source.

---

## 7. Download options — the one rule that matters

Clients send **intent**; the server resolves it. The previous implementation let
the client compute a format id and send it alongside `audio_only: true`, which
produced a merged video+audio selector for an audio-only job, which then failed
on a missing merge step. Do not repeat that shape.

```json
{
  "url": "...",
  "mode": "audio",
  "quality": "1080p",
  "format_id": null,
  "audio_format": "mp3",
  "audio_quality": 192,
  "container": "mp4",
  "playlist": false,
  "subtitles": [], "auto_subtitles": false, "embed_subtitles": false,
  "write_thumbnail": false, "embed_thumbnail": true, "embed_metadata": true,
  "output_template": null,
  "concurrent_fragments": 4,
  "rate_limit": null
}
```

Resolution rules, implemented in exactly one function:

1. `mode: "audio"` produces an audio-only selector. `quality` and `container`
   are ignored, and a merged (`a+b`) selector is never produced.
2. `mode: "video"` produces a height-capped selector from `quality`.
3. An explicit `format_id` is an escape hatch and wins **only if it is
   compatible with `mode`**. A merged `a+b` id combined with `mode: "audio"` is
   a `400 format_mode_conflict` — reject it at the API boundary rather than
   letting it fail deep inside yt-dlp with a confusing message.

---

## 8. External binaries — plan for this first

The code is the easy part. Shipping the binaries is where the time goes.

**ffmpeg + ffprobe.** Required for merging, audio extraction, and any embedding
of thumbnails, metadata, or subtitles. Bundle them; never assume `PATH`. Point
yt-dlp at ffmpeg explicitly and keep ffprobe *beside it under its plain name* —
yt-dlp derives ffprobe's location from ffmpeg's directory. This rules out
Tauri's `externalBin` sidecar mechanism, which renames binaries to
`ffmpeg-x86_64-pc-windows-msvc.exe` and leaves ffprobe unfindable. Ship the
directory as a bundle resource instead and pass its path in an env var.

**A JavaScript runtime.** YouTube requires one to solve signature challenges;
without it, extraction silently degrades and formats go missing. QuickJS is
about 2 MB against Deno's ~100 MB, and yt-dlp supports it. Note the library
option is a dict — `{"quickjs": {"path": "..."}}` — not the CLI's
`RUNTIME:PATH` string, and the value must be a dict rather than `None`.

**PO tokens — a design constraint, not a bug.** Without one, YouTube caps
un-tokened media downloads: a single ranged request above roughly 512 KiB is
refused, and a chunked download stops after about 0.7 MB. No client-side chunk
tuning fixes this. Plan for cookies (read from the user's browser, configurable)
and an optional PO-token provider, and surface the condition under its own error
code so integrators get a real explanation instead of a bare 403.

**Resolver contract**, identical for every binary:

```
env override  ->  bundled directory  ->  PATH
```

`/health` reports which one won:

```json
{ "status": "ok", "version": "...", "yt_dlp_version": "...",
  "ffmpeg":     { "path": "...", "source": "bundled" },
  "ffprobe":    { "path": "...", "source": "bundled" },
  "js_runtime": { "name": "quickjs-ng", "version": "0.16.2", "source": "bundled" },
  "cookies": false, "po_token_provider": false,
  "max_concurrent": 2, "jobs": {}, "websocket_clients": 0 }
```

A packaging mistake then shows up as `"source": "path"` on the dev machine
instead of hiding until someone runs a clean install.

---

## 9. Configuration

All env-overridable, all with working defaults.

| Variable | Default | |
| --- | --- | --- |
| `DOWNLOAD_DIR` | `./downloads` | one subdirectory per job id |
| `MAX_CONCURRENT` | `2` | downloads at once; the rest queue |
| `JOB_TTL` | `86400` | seconds a finished job is retained |
| `EVENT_HISTORY` | `250` | events buffered per channel for replay |
| `PROGRESS_INTERVAL` | `0.25` | min seconds between progress events |
| `INFO_CACHE_TTL` | `300` | metadata cache; `0` disables |
| `API_TOKEN` | — | if set, every request must carry it |
| `CORS_ORIGINS` | `*` | comma-separated; permissive by default for local tools |
| `FFMPEG_DIR` | — | directory or binary path; overrides the search |
| `JS_RUNTIME_DIR` | — | directory or binary path |
| `COOKIES_FROM_BROWSER` | — | `firefox`, `chrome`, … |
| `COOKIE_FILE` | — | Netscape cookie file, alternative to the above |
| `HTTP_CHUNK_SIZE` | `262144` | forces ranged GETs; `0` disables |
| `SERVE_FILES` | `true` | false when something else serves the output |

---

## 10. Errors

One envelope, always:

```json
{ "error": { "code": "po_token_required",
             "message": "human-readable, for logs and UI",
             "detail": {} } }
```

| code | meaning |
| --- | --- |
| `invalid_url` | not a URL, or no extractor matches |
| `unsupported_site` | an extractor exists but refused the URL |
| `video_unavailable` | private, removed, geo-blocked, age-gated |
| `format_unavailable` | the requested format does not exist for this video |
| `format_mode_conflict` | `format_id` contradicts `mode` (see §7) |
| `po_token_required` | download capped or refused; needs cookies or a token provider |
| `ffmpeg_missing` | a postprocessor was requested but no ffmpeg resolved |
| `js_runtime_missing` | extraction needs a JS runtime and none resolved |
| `network_error` | transport failure, after retries |
| `disk_error` | write failed, out of space, permissions |
| `job_not_found` | unknown job id |
| `cancelled` | terminal state following a cancel request |

Preflight everything you can. If a job asks for mp3 output and no ffmpeg
resolved, fail immediately with `ffmpeg_missing` — do not download 200 MB first
and fail in postprocessing.

---

## 11. Build order

1. **Skeleton + `/health`.** Binary resolution and capability reporting first.
   It is the thing most likely to be wrong later, and everything else assumes it.
2. **Metadata routes.** `/info`, `/formats`, `/subtitles`, with normalisation
   and the cache. Confirm a JS runtime is genuinely being used.
3. **The event bus.** Envelope, `seq`, per-channel ring buffer, replay. Test it
   with synthetic events before any download exists.
4. **Jobs.** Registry, queue, cancellation, options resolution (§7). Wire the
   real yt-dlp hooks into the bus.
5. **WebSockets.** Both endpoints, replay, heartbeat.
6. **File routes**, with `Range` support.
7. **Clients.** CLI and a minimal web page, strictly as API consumers.

Step 3 before step 4 matters: the event contract is what external tools depend
on, so settle it before job semantics complicate it.

---

## 12. If persistence becomes a requirement

State is in-memory, so jobs vanish on restart and the server is single-process.
For a desktop app that is often fine. If it stops being fine, SQLite is the
right next step, and the seams are the job registry and the event buffer — both
small enough to swap without touching the routes.
