# Inferno, as a server

The same app, in a container: one image, one process, one port. uvicorn serves
the REST API, the websockets and the built frontend together, so the browser
talks to the API on its own origin and there is no CORS, no token in a query
string, and no second container holding a `proxy_pass`.

This lives in the same repository as the desktop app **on purpose**. The two
share `service/` — the download engine and its API contract — and that is
exactly the code a fork would duplicate and then let drift. One flag decides
which product a build is.

---

## Quick start

```bash
cd docker
cp .env.example .env
docker compose up --build
```

Then open <http://127.0.0.1:8765>. Or without compose, from the repo root:

```bash
npm run docker:build
docker run -p 127.0.0.1:8765:8765 -v inferno-data:/data inferno-server
```

Check it came up healthy — this reports what actually resolved inside the
image, so a packaging mistake shows up here rather than on a first download:

```bash
curl -s http://127.0.0.1:8765/health | python -m json.tool
```

---

## What is and is not built

Read this before deploying anything.

### Works

- The full download pipeline: queue, progress over websocket, cancel, merge.
- The whole UI, minus the window controls, in a browser.
- Settings, persisted to `/data`.
- Files land on the `/data` volume and are served by the API.

**File actions**, which the desktop does through the OS and the browser cannot:

- **Open** becomes *Open in a new tab* — renamed, not just rewired, because
  "Open" in a browser invites the reasonable guess that something opens on
  *your* machine. The browser decides what happens with it: an mp4 plays
  inline, a mkv downloads. That is the browser's call to make and it makes it
  from the content type, which is why the image installs `media-types`.
- **Download** saves the file to the machine the browser is on. Container only:
  on the desktop the file is already there, so this would copy it beside
  itself.
- **Open file location** opens a **file browser dialog** over
  `GET /api/v1/files`, listing the folder with that file marked. It navigates
  into subfolders, and each file gets open and download buttons. The server
  bounds every path to the download folder — absolute or relative, symlinks
  resolved before the check — so it cannot browse the host.

The library screen does not appear at all: it is backed by SQLite through Tauri
and returns nothing in a browser. That is why it needed no gating.

### Not built yet

- **Cloud storage providers.** Google Drive, OneDrive and the rest are not
  implemented. Downloads stop at the `/data` volume.
- **The native directory picker**, in Settings' save locations, and the
  Soundpad and Spotify sections. Still visible, still inert. The picker is
  waiting on the storage layer for the same reason as before: its right cloud
  behaviour is *pick a Drive folder*, so gating it off now means writing it
  twice.

### Cannot work in a container, ever

Soundpad (a Windows desktop application), scanning a local Spotify install,
taskbar progress, and `COOKIES_FROM_BROWSER` — there is no browser profile in
an image. Use `COOKIE_FILE` instead.

---

## How the build works

One environment variable, `NEXT_PUBLIC_INFERNO_TARGET`, set to `cloud` in the
Dockerfile. Next inlines `NEXT_PUBLIC_*` at build time, so `lib/deployment.ts`
resolves to a constant and the container-only branches are statically dead.
Anything other than `cloud` yields the desktop build, which is why the desktop
app needs no changes and gets none.

Verified, not assumed — `npm run build` renders all three window controls into
`out/index.html`; `npm run build:cloud` renders none, and keeps the toolbar:

```bash
npm run build       && grep -c 'aria-label="Minimise"' out/index.html   # 1
npm run build:cloud && grep -c 'aria-label="Minimise"' out/index.html   # 0
```

Both write to `out/`, so they overwrite each other. Run `npm run build` before
packaging the desktop app if `build:cloud` ran last.

On the service side the switch is `INFERNO_WEB_ROOT`. Set, the service mounts
that directory at `/` after every API route is registered, so the mount can
only ever pick up what the API did not claim. Unset — every desktop install —
no mount is added and `/` serves the bundled test client exactly as before.
`/client` always reaches that test client, which is how you tell "the API is
fine, the UI is broken" from "the service is down".

---

## Security

**This image ships with no authentication, and the compose file binds it to
127.0.0.1 for that reason.**

The service supports a shared `API_TOKEN`, but the browser frontend does not
send one: outside Tauri, `getServiceEndpoint()` returns an empty token, because
on a desktop install the API is on localhost and the token comes from the Tauri
side. Set `API_TOKEN` and the API is protected while the UI gets a 401 on every
request. Pick one; you cannot have both today.

So for anything beyond loopback, authenticate in front of it — OAuth2 Proxy,
Authelia, Cloudflare Access, or basic auth in a reverse proxy. Do not simply
change the port binding to `0.0.0.0`; Docker writes its own iptables rules and
will publish straight through a host firewall that would otherwise have stopped
it. SPEC §2 lists multi-user auth as an explicit non-goal of the service, so
this is a gap to close in front of it rather than inside it.

`CORS_ORIGINS` must be non-empty to mean anything — an empty value is treated
as unset and falls back to the service's default of `*`. `.env.example` sets it
to the deployment's own origin.

---

## The thing that will actually bite you

YouTube serves "Sign in to confirm you're not a bot" to datacenter IP ranges far
more aggressively than to residential ones. Downloads that work on your desktop
can fail on a VPS for this reason alone, and it is not a bug in the service.

If you are planning to host this somewhere, test that **first** — before
building anything on top of it. A residential or well-reputed proxy (`PROXY=`)
is the reliable fix; a cookie file (`COOKIE_FILE=`) helps with age-gated and
some throttled content.

---

## Publishing

```bash
docker build -f docker/Dockerfile -t <user>/inferno-server:0.1.0 .
docker tag <user>/inferno-server:0.1.0 <user>/inferno-server:latest
docker push <user>/inferno-server:0.1.0
docker push <user>/inferno-server:latest
```

Two things to check before a public push. The image bundles **ffmpeg** (GPL)
and **yt-dlp** (Unlicense) alongside this project's MIT code, so the
distribution as a whole carries their terms — ffmpeg's copyleft is the one that
actually constrains you. And an image tagged `latest` that anyone can `docker
run` is an unauthenticated downloader by default; the README they will not read
is this one.

For multi-architecture (Apple silicon, ARM servers):

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile -t <user>/inferno-server:0.1.0 --push .
```

---

## Files

| Path | What it is |
| --- | --- |
| `docker/Dockerfile` | Two stages: build the frontend, then the Python runtime. |
| `docker/docker-compose.yml` | Loopback binding, `/data` volume, memory limit. |
| `docker/.env.example` | Every knob, with the reasoning. Copy to `.env`. |
| `lib/deployment.ts` | The build flag and the capability list. |
| `scripts/build-cloud.mjs` | `next build` with the flag, on any OS. |

The service-side change is `_web_root()` and `_install_web_root()` in
`service/inferno_service/main.py`, plus the `INFERNO_WEB_ROOT` check in
`client_page`. Nothing else in the service moved.
