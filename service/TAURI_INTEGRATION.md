# Integrating `inferno-service` into the Inferno Tauri app

Everything the next agent needs to wire this service into the desktop app in
the repository root above this directory.

Read [SPEC.md](SPEC.md) for *why* the service is shaped this way and
[README.md](README.md) for the API surface. This document is only about the
integration.

---

## 0. The one rule

**The desktop app gets no privileged path.** It talks to the service over the
same public HTTP + WebSocket API the CLI and the bundled web client use. There
is no in-process shortcut and none should be added — SPEC §1 calls that a design
bug, not a shortcut.

Practically: if the app needs something the API cannot express, add it to the
API, not to a Tauri command that reaches around it.

---

## 1. What you are integrating

| | |
| --- | --- |
| Repo | `service/`, vendored into this repository |
| Python package | `inferno_service` |
| Entry point | `python -m inferno_service` / `inferno-service` |
| Default bind | `127.0.0.1:8765` |
| Health probe | `GET /health` |
| Docs | `GET /docs`, `GET /openapi.json` |
| Test suite | `pytest` — 378 passing, hermetic, no network |
| Live suite | `INFERNO_LIVE=1 pytest -m live` — real YouTube |

State is in-memory: jobs do not survive a restart (SPEC §2). Settings *do* —
see §5.

---

## 2. Shipping it inside the app

Three things ship: the service, ffmpeg + ffprobe, and QuickJS.

### 2.1 ffmpeg, ffprobe, QuickJS — resources, never `externalBin`

This is the trap SPEC §8 exists to warn about. Tauri's `externalBin` renames
binaries to `ffmpeg-x86_64-pc-windows-msvc.exe`. yt-dlp derives **ffprobe's**
location from ffmpeg's directory and expects it under its plain name, so a
renamed pair leaves ffprobe unfindable and every merge fails.

Ship the directory as a bundle resource instead:

```jsonc
// src-tauri/tauri.conf.json - as shipped
"bundle": {
  "resources": {
    "../service/dist/inferno-service/": "service/",
    "../service/vendor/": "vendor/"
  }
}
```

Then at runtime resolve `resource_dir()/vendor/ffmpeg` and pass it in
`FFMPEG_DIR`, and `resource_dir()/vendor/js` in `JS_RUNTIME_DIR`.

`/health` reports `"source": "bundled" | "env" | "path"` for each binary, so a
packaging mistake shows up immediately rather than on a clean install. Assert on
it in a smoke test.

### 2.2 The service binary

Two workable shapes. **Prefer onedir.**

**Onedir under resources (recommended).** PyInstaller `--onedir` produces a
folder; ship it as a resource and spawn the exe directly.

```bash
pyinstaller --onedir --name inferno-service \
  --collect-all yt_dlp \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  inferno_service/__main__.py
```

Onefile re-extracts ~40 MB to a temp directory on **every** launch, costing one
to three seconds of startup. Onedir does not, and you are already shipping a
resource directory for ffmpeg, so it costs no extra machinery.

**Onefile as `externalBin`.** More idiomatic Tauri and simpler signing on macOS.
Add `"externalBin": ["binaries/inferno-service"]`, place the file as
`binaries/inferno-service-x86_64-pc-windows-msvc.exe`, and spawn with
`app.shell().sidecar("inferno-service")`. Requires `tauri-plugin-shell`.

Unlike ffmpeg, the *service* is safe to rename — nothing derives a sibling path
from it.

### 2.3 During development

Do not build a binary to iterate. Let the app connect to a service you started
by hand:

```bash
cd service
.venv/Scripts/python.exe -m inferno_service --port 8765
```

Have the Rust side check an `INFERNO_SERVICE_URL` env var first and skip
spawning when it is set. That keeps the frontend loop fast.

---

## 3. Spawning and lifecycle

### 3.1 What to pass, and what not to

This is the single most important integration decision.

**Pass only bootstrap values as environment variables:**

| Env | Why |
| --- | --- |
| `INFERNO_CONFIG_FILE` | Where settings persist. Point it inside the app's data dir. |
| `API_TOKEN` | A fresh random token per launch. |
| `FFMPEG_DIR` | Resolved resource path. |
| `JS_RUNTIME_DIR` | Resolved resource path. |
| `CORS_ORIGINS` | See §4.1. |

**Do not pass anything else.** Every env var you set *pins* that setting: it
wins over the config file and `PATCH /api/v1/settings` refuses to change it with
`409 setting_locked`. Passing `MAX_CONCURRENT` or `DOWNLOAD_DIR` at spawn would
render those controls dead in your own settings screen. Let them come from the
config file, which the app edits through the API.

The service reports this honestly: every schema entry carries
`locked_by_env: true` and `source: "env"`, so the UI can grey out a locked
control rather than silently discarding the user's edit. That mechanism exists
for genuine deployment overrides — not for the app's own preferences.

### 3.2 Port

Do not hard-code 8765; a second instance or an unrelated process will collide.
Bind a port with `TcpListener::bind("127.0.0.1:0")`, read it, drop the listener,
and pass `--port`. Small race, acceptable in practice. Alternatively retry a few
candidate ports until `/health` answers.

### 3.3 Readiness

The process is up before the HTTP server is. Poll `GET /health` until it returns
200, with a timeout of about 30 seconds (first launch may be slower). Surface a
clear failure if it never comes up — capture stderr, it carries the reason.

### 3.4 Shutdown and crashes

Kill the child on app exit, including on panic. On Windows a child does not die
with its parent by default; use a Job Object or make sure you kill it in
`RunEvent::ExitRequested`. Leaked services holding a port are the classic bug.

Also handle the service dying while the app runs: watch the child, and on
unexpected exit either respawn (and tell the frontend to reconnect) or show a
clear error. In-flight jobs are lost — state is in-memory.

### 3.5 Rust sketch

Follow the existing `src-tauri/src/addons/soundpad/` pattern: a module with
`mod.rs`, `commands.rs`, `error.rs`, plus state in `lib.rs`.

```rust
// src-tauri/src/addons/inferno_service/mod.rs
pub struct ServiceHandle {
    pub base_url: String,   // http://127.0.0.1:<port>
    pub token: String,
    child: Mutex<Option<CommandChild>>,
}
```

Expose exactly two commands to the frontend:

```rust
#[tauri::command]
fn inferno_service_endpoint(state: State<ServiceHandle>) -> Endpoint {
    Endpoint { base_url: state.base_url.clone(), token: state.token.clone() }
}

#[tauri::command]
async fn inferno_service_status(state: State<ServiceHandle>) -> Status { /* … */ }
```

Register them in `lib.rs` alongside the soundpad handlers. Do **not** proxy the
REST API through Rust commands — the frontend should call the service directly
over `fetch`. Proxying adds a layer that will drift from the API and breaks the
"no back doors" rule.

Spawning from Rust `setup()` needs the shell plugin registered but no capability
entry — capabilities gate the *frontend* JS API, not Rust.

---

## 4. Frontend integration

### 4.1 CORS

The Next export runs from a custom scheme. On Windows that is
`http://tauri.localhost`; on macOS and Linux it is `tauri://localhost`. Set:

```
CORS_ORIGINS=http://tauri.localhost,tauri://localhost,http://localhost:3000
```

The last entry keeps `npm run dev:web` working in a browser. The default is `*`,
which is fine locally, but pinning it is better hygiene once a token is in play.

### 4.2 Getting the endpoint into React

```ts
import { invoke } from "@tauri-apps/api/core"

const { base_url, token } = await invoke<Endpoint>("inferno_service_endpoint")
```

Hold it in a context provider. Every REST call sends `X-API-Key: <token>`;
every WebSocket appends `?token=<token>` because browsers cannot set headers on
a WebSocket — which is exactly why the service accepts both forms (SPEC §4).

### 4.3 Live progress

Open **one** firehose to `/ws/events` for the whole app, not one socket per job.
Frames all share one envelope:

```json
{ "type": "progress", "job_id": "a1b2", "ts": 1756400000.12, "seq": 42, "data": {} }
```

Track the last `seq` you saw and reconnect with `?since=<seq>`; you will get
everything you missed. If the buffer had already discarded it, the first frame
says `data.replay_truncated: true` — refetch `GET /api/v1/downloads` to
resynchronise rather than trusting the partial stream.

Event types are listed in the README. The ones the UI needs are
`job.queued` / `job.extracting` / `job.downloading` / `job.postprocessing`,
`progress`, `progress.finished`, `postprocessor`, the three terminal
`job.*` events, and `settings.changed`.

### 4.4 The progress bar — do not do this yourself

yt-dlp reports progress **per stream**. On a video+audio merge, percent runs
0→100 twice. Rendering `data.percent` directly gives a bar that fills twice; it
looks broken and it has already been reported once.

The service deliberately does not paper over this (SPEC §1: raw values,
presentation is the client's job). Port the reference implementation instead:
`DownloadProgress` in
[inferno_service/clients/cli.py](inferno_service/clients/cli.py), mirrored in
[client.html](inferno_service/clients/client.html).

The model, in one paragraph: collapse the job into three stages — *preparing*
(`queued`/`extracting`), *downloading*, *processing* (`postprocessing`). Stages
one and three are **indeterminate**; extraction has no measurable total and
ffmpeg reports no percentage, so inventing one is a lie. Stage two is weighted
**by stream, not bytes**: each expected stream owns an equal slice, so video
fills 0–50% and audio 50–100%. Read the expected count from the job's
`options.merging`. Keep a high-water mark so the bar can never move backwards.

Byte-weighting looks more accurate and is not: the audio stream's size is
unknown until it starts, and on a real 360p YouTube download that was 15.3 MB of
video followed by 10.2 MB of audio — a byte-weighted bar hits 99.9% and then
drops to 60%.

**Update — stage three is determinate after all, in steps.** The claim above
that "processing" has to be indeterminate is true only of *time*: ffmpeg's
percentage never reaches the client, because yt-dlp's `FFmpegPostProcessor` has
no progress hook at all — it runs ffmpeg through `Popen` and reads stderr only
for errors. But the number of postprocessing *steps* is known, and each one
reports `finished` on the `postprocessor` event, so the stage can show a real
fraction of real work.

The step count is not `len(options.postprocessors)`. That lists only what the
request resolved to, under configured names, and yt-dlp runs more than that
under class names. Measured against this service:

| Job | `options.postprocessors` | Events actually seen |
| --- | --- | --- |
| video 360p, merge, thumbnail + metadata | `FFmpegMetadata`, `EmbedThumbnail` | `Merger`, `Metadata`, `EmbedThumbnail`, `MoveFiles` |
| audio mp3, thumbnail + metadata | `FFmpegExtractAudio`, `FFmpegMetadata`, `EmbedThumbnail` | `ExtractAudio`, `Metadata`, `EmbedThumbnail`, `MoveFiles` |

Two of the extras are predictable rather than guessable: yt-dlp always finishes
with `MoveFiles`, and adds `Merger` whenever the selector merges. So

```
expected = len(options.postprocessors) + (options.merging ? 1 : 0) + 1
```

which is exactly 4 in both rows above. Take the observed distinct count as a
floor under that, keep a high-water mark, and the bar cannot go backwards even
when the estimate is wrong. Count distinct *names* that reported `finished`:
every postprocessor fires its `started`/`finished` pair more than once.

If a genuine time-based percentage is ever wanted, it belongs in the service —
patch `FFmpegPostProcessor` to run ffmpeg with `-progress pipe:1`, parse
`out_time_us` against the known duration, and add `percent` to the
`postprocessor` event. It is not something a client can synthesise.

### 4.5 Files

Never read the download directory from the frontend. Fetch through
`GET /api/v1/downloads/{id}/files/{name}`, which supports HTTP `Range`. If you
want a "reveal in folder" button, that is a Tauri command using the path from
the job object — but the *bytes* come from the API.

---

## 5. Settings

The part you asked to be easy. It is schema-first and layered.

### 5.1 Three tiers

| Tier | Lives where | Example |
| --- | --- | --- |
| **App preferences** | The app's own store | theme, launch on startup, last section |
| **Service settings** | The service, `scope: "service"` | download folder, concurrency, proxy, cookies |
| **Download defaults** | The service, `scope: "download"` | quality, container, audio format, embeds |

Download defaults matter: a client can `POST {"url": "..."}` with nothing else
and the job inherits the user's chosen quality. Only fields the client
*explicitly sends* override them, so `{"url": ..., "embed_thumbnail": false}`
overrides exactly one field and inherits the rest.

### 5.2 The API

```
GET   /api/v1/settings     -> values + download_defaults + schema + groups
PATCH /api/v1/settings     -> { "values": { "downloads.max_concurrent": 4 } }
                              { "reset":  ["media.quality"] }   // [] resets all
```

One `GET` returns everything a settings screen needs. Each schema entry carries
`type`, `default`, `value`, `label`, `description`, `group`, `minimum`,
`maximum`, `choices`, `unit`, `scope`, `env`, `runtime`, `secret`, plus the live
`source` and `locked_by_env`.

`PATCH` is partial. `null` clears an override and falls back to the default.
Changes apply **live** — concurrency resizes without interrupting running
downloads, the download folder and cookies and ffmpeg paths are re-read, the
metadata cache TTL retunes. `restart_required` in the response lists any changed
key that needs a restart (only `server.api_token`, `server.cors_origins` and
`events.history`).

Every change is broadcast as a `settings.changed` event, so a second window or
the bundled web client converges without polling.

Failure modes are distinguishable on purpose: an invalid value is `422
invalid_request`, an env-pinned key is `409 setting_locked`.

### 5.3 Generated TypeScript — do not hand-write the types

```bash
python -m inferno_service --emit-typescript ../../inferno-app/lib/inferno-settings.ts
```

That emits `ServiceSettings`, `DownloadDefaults`, `InfernoSettings`,
`SettingKey`, `SETTINGS_DEFAULTS`, `SETTINGS_SCHEMA` and `SETTINGS_GROUPS`.
Choice settings become literal unions (`"video" | "audio"`), nullable settings
become `| null`. It typechecks under `--strict`.

Add it to `package.json` so it cannot rot:

```jsonc
"scripts": {
  "gen:settings": "python -m inferno_service --emit-typescript lib/inferno-settings.ts"
}
```

Because `SETTINGS_SCHEMA` carries labels, groups, ranges and choices, the
settings screen can be **generated** rather than hand-built: map `type` to a
control (`bool` → Switch, `choice` → Select, `int` with min/max → Slider,
`string`/`path` → Input), group by `group`, and disable anything with
`locked_by_env`. That is the payoff of the schema being the single source of
truth — adding a setting is one row in `SETTINGS` and it appears everywhere.

### 5.4 Mapping the app's existing `SettingsConfig`

`components/sections/settings/settings-config.ts` already has a shape. Here is
where each field belongs.

| App field | Service key | Notes |
| --- | --- | --- |
| `appearance.theme` | — | App only |
| `downloads.location` | `downloads.directory` | service |
| `downloads.concurrentDownloads` | `downloads.max_concurrent` | service, live, 1–16 |
| `downloads.filenameTemplate` | `downloads.output_template` | download default |
| `downloads.autoStartQueued` | — | App only; see §7 |
| `video.quality` | `media.quality` | app offers a subset of the service's choices |
| `video.container` | `media.container` | |
| `video.embedSubtitles` | `media.embed_subtitles` | |
| `audio.format` | `media.audio_format` | |
| `audio.bitrateKbps` | `media.audio_quality` | same unit, no conversion |
| `audio.embedMetadata` | `media.embed_metadata` | |
| `audio.embedThumbnail` | `media.embed_thumbnail` | |
| `startup.*` | — | App only |
| `network.rateLimitKbps` | `network.rate_limit` | **unit differs — see below** |
| `network.retries` | `network.retries` | service |
| `network.proxyUrl` | `network.proxy` | service |
| `diagnostics.*` | — | App only; service logs arrive as `log` events |

Two things to get right:

**`filenameTemplate` is already handled.** The app's default is `{title}.{ext}`.
yt-dlp's own syntax is `%(title)s.%(ext)s`, and passing braces through untouched
would produce a file genuinely named `{title}.{ext}` — a silent wrong-output
bug. The service now translates friendly `{field}` placeholders and leaves
`%(...)s` templates alone. Send the app's value unchanged.

**`rateLimitKbps` needs a conversion and a decision.** The service takes
`network.rate_limit` in **bytes per second**. If "Kbps" means kilobits,
multiply by 125; if it means kibibytes, multiply by 1024. Pick one, rename the
app field to match (`rateLimitKbits` or `rateLimitKiB`), and convert at the
boundary. Leaving it ambiguous will produce a speed limit that is wrong by 8×.

### 5.5 Migration

The app currently persists to `localStorage` under
`inferno-app.settings-config`. On first run after integration, read that, push
the service-owned fields via one `PATCH`, and keep only the app-only fields
locally. Bump `schemaVersion` so it happens once.

---

## 6. Errors

Every failure — including framework 404s — uses one envelope:

```json
{ "error": { "code": "po_token_required", "message": "…", "detail": {} } }
```

Switch on `code`, never on the message. Suggested UI treatment:

| Code | HTTP | What the user should see |
| --- | --- | --- |
| `invalid_url` | 400 | "That does not look like a supported link." |
| `unsupported_site` | 400 | "This site is not supported." |
| `video_unavailable` | 404 | "Private, removed, or blocked in your region." |
| `format_unavailable` | 400 | "That quality is not available for this video." |
| `format_mode_conflict` | 400 | A bug in the app — it sent a contradictory `format_id`. Log it. |
| `po_token_required` | 403 | "YouTube is limiting this download. Sign in via cookies in Settings." Deep-link to the privacy group. |
| `ffmpeg_missing` | 503 | "A required component is missing." Packaging bug — surface `detail.reasons`. |
| `js_runtime_missing` | 503 | Same. Packaging bug. |
| `network_error` | 502 | "Connection problem." Offer retry. |
| `disk_error` | 500 | "Could not write the file." Show `detail.filename`. |
| `job_not_found` | 404 | Refetch the job list. |
| `setting_locked` | 409 | "This is managed by your installation." Disable the control. |
| `invalid_request` | 422 | A bug in the app. Log `detail.errors`. |
| `unauthorized` | 401 | Token drift — re-invoke the endpoint command. |

`po_token_required` is the one to design for properly. Without cookies, YouTube
caps un-tokened downloads and it will happen to real users. The path out is
`privacy.cookies_from_browser`; make that discoverable from the error.

---

## 7. Known gaps

Real things the app will want that the service does not do yet. None are
blockers; all are honest additions to the API rather than workarounds.

1. **No paused/queued-but-not-started state.** `POST /downloads` starts a job as
   soon as a slot frees. `downloads.autoStartQueued` therefore has to be
   implemented app-side by delaying the POST. If you would rather the service
   own it, add a `paused` status and a `POST /downloads/{id}/start`.
2. **Jobs do not survive a restart** (SPEC §2). If the app should show history
   across launches, either persist a job mirror app-side or implement SPEC §12
   (SQLite; the seams are the job registry and the event buffer).
3. **No PO-token provider.** `/health` reports `po_token_provider: false`.
   Cookies are the current mitigation.
4. **No global pause/resume or reordering.** Cancel and re-queue is the only
   path today.
5. **`GET /api/v1/downloads` has no pagination** beyond `?limit=`. Fine for
   hundreds, not thousands.

---

## 8. Checklist

- [ ] `pytest` green in the service repo before touching the app
- [x] `python -m inferno_service --check` exits 0 with all three binaries resolved
      (`bundled` when run from the checkout; `env` under the app, which passes
      `FFMPEG_DIR`/`JS_RUNTIME_DIR` as §2.1 instructs — both are correct)
- [ ] vendor/ shipped as a Tauri **resource**, ffprobe beside ffmpeg, plain names
- [ ] Service spawned with a free port, per-launch token, and **only** bootstrap env
- [ ] `/health` polled until ready; stderr captured on failure
- [ ] Child killed on `ExitRequested`, verified with Task Manager
- [ ] `CORS_ORIGINS` includes the Tauri scheme for the target platform
- [ ] One firehose socket, reconnect with `?since=`, handle `replay_truncated`
- [ ] Progress bar uses the three-stage stream-weighted model, not `data.percent`
- [ ] `npm run gen:settings` wired, `lib/inferno-settings.ts` committed
- [ ] Settings screen driven by `SETTINGS_SCHEMA`, `locked_by_env` disables controls
- [ ] `rateLimitKbps` unit decided and converted
- [ ] Error handling switches on `code`; `po_token_required` deep-links to cookies
- [ ] `localStorage` settings migrated once via `PATCH`

---

## 9. Quick reference

```bash
# Run the service
python -m inferno_service --port 8765 --config-file ./inferno-settings.json

# What resolved, and from where
python -m inferno_service --check

# Regenerate the app's settings types
python -m inferno_service --emit-typescript ../../inferno-app/lib/inferno-settings.ts

# Try the API without the app
inferno-cli health
inferno-cli formats "https://www.youtube.com/watch?v=..."
inferno-cli download "https://www.youtube.com/watch?v=..." --quality 1080p
```

The bundled web client at `http://127.0.0.1:8765/` is a working reference for
every integration point in this document — endpoint usage, the firehose,
reconnect with `?since=`, and the three-stage progress bar — in about 250 lines
of dependency-free JavaScript. Read it before writing the React version.
