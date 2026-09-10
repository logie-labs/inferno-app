# syntax=docker/dockerfile:1.7
#
# Inferno, as a server.
#
# One image, one process, one port: uvicorn serves the API, the websockets and
# the built frontend together. That is not a shortcut taken to avoid nginx - it
# is what lets the browser talk to the API same-origin, which means no CORS
# preflight, no token in a query string, and no second container whose only job
# is to hold a `proxy_pass`.
#
# Build from the repository root, not from this directory:
#
#   docker build -f docker/Dockerfile -t inferno-server .
#
# The build context is the repo because stage one needs the whole frontend and
# stage two needs `service/`. `.dockerignore` keeps `src-tauri/`, `node_modules`
# and the vendored Windows binaries out of it.


# ---------------------------------------------------------------------------
# Stage 1 - the frontend
#
# `next.config.ts` sets `output: "export"`, so this produces a directory of
# static files rather than a Node server. Nothing from this stage's toolchain
# reaches the final image.
#
# Pinned to BUILDPLATFORM - the machine doing the building - rather than
# TARGETPLATFORM. The output is HTML, CSS and JavaScript, which is identical
# whatever the target architecture, so building it once natively is not a
# shortcut: emulating a Node toolchain under QEMU to produce byte-identical
# static files would multiply the build time of the arm64 image for nothing.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web

WORKDIR /build

# Dependencies first, on their own layer: package.json and the lockfile change
# far less often than the source does, so an edit to a component reuses the
# install instead of repeating it.
COPY package.json package-lock.json ./

# `npm install`, not `npm ci`, and not by preference.
#
# The lockfile was generated on Windows, so it records only the optional
# dependencies npm resolves *there*. On Linux npm additionally wants the wasm32
# fallbacks - `@tailwindcss/oxide-wasm32-wasi` and `@img/sharp-wasm32` - and
# their transitive `@emnapi/core` and `@emnapi/runtime`, which are absent. That
# is not a warning: `npm ci` refuses outright with EUSAGE, "can only install
# packages when your package.json and package-lock.json are in sync".
#
# Neither obvious fix is right yet. Regenerating the lockfile from scratch on
# Linux does add them, but it also moves 118 other packages - including a
# `@base-ui/react` minor and a `@hono/node-server` major - which is not a change
# to make inside a Docker fix, untested against the desktop app. Hand-merging
# the four missing entries is fragile: the versions differ between the hoisted
# and nested positions, and a lockfile that is subtly wrong fails later and
# less legibly than one that is obviously wrong.
#
# So this resolves within the lockfile's semver ranges at build time. The cost
# is real - two builds of the same commit can differ - and the fix is to
# regenerate the lockfile on Linux, verify the desktop app against it, commit
# it, and change this line back to `npm ci`.
RUN npm install --no-audit --no-fund

COPY . .

# The flag that makes this the container build rather than the desktop one.
# `lib/deployment.ts` reads it, Next inlines it, and the window controls are
# statically dead from here on. Anything but "cloud" yields the desktop build,
# so this line is the entire difference.
ENV NEXT_PUBLIC_INFERNO_TARGET=cloud
ENV NEXT_TELEMETRY_DISABLED=1

# `next/font/google` fetches Manrope and Geist Mono at build time, so this step
# needs network access. It is the only step that does.
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2 - the runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# ffmpeg and ffprobe are not optional: yt-dlp merges separate video and audio
# streams with them, and without the pair every download above 720p fails at
# the merge rather than at the fetch. They are installed as a package here
# instead of being vendored, so ffprobe sits beside ffmpeg on PATH under its
# own name - the naming trap `service/TAURI_INTEGRATION.md` §2.1 warns about
# does not arise when the distribution does the installing.
#
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The JS runtime, which is not optional however much it looks like it.
#
# yt-dlp needs it to solve YouTube's signature challenges. Without one,
# extraction degrades *silently*: adaptive (video-only and audio-only) formats
# simply go missing instead of raising, so you get a working-looking service
# that can only fetch low-quality muxed streams. service/vendor/README.md
# spells this out, and a first attempt here got it wrong - `apt-get install
# quickjs` tolerated with `|| true`, which looked prudent and shipped an image
# with no runtime at all, because quickjs is in trixie and sid but not in
# bookworm. Hence: fetch it explicitly, and let the build fail if that fails.
#
# quickjs-ng, not Bellard's original - it is the fork yt-dlp targets and the one
# that publishes prebuilt binaries. Pinned to the same version the desktop app
# vendors, so both products resolve identically.
ARG TARGETARCH
ARG QUICKJS_VERSION=v0.16.2
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) qjs_arch=x86_64 ;; \
      arm64) qjs_arch=aarch64 ;; \
      *) echo "no quickjs-ng build for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/quickjs-ng/quickjs/releases/download/${QUICKJS_VERSION}/qjs-linux-${qjs_arch}"; \
    echo "Fetching $url"; \
    python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], '/usr/local/bin/qjs')" "$url"; \
    chmod +x /usr/local/bin/qjs; \
    # Proves it runs on this architecture rather than merely downloading - a
    # wrong-arch binary is an exec format error at first use, not at install.
    qjs -e 'console.log("quickjs-ng ok")'

# Install the service from source. Copying only `service/` keeps the frontend's
# source out of the runtime image entirely - what ships is the built output.
WORKDIR /app
COPY service/pyproject.toml service/README.md ./service/
COPY service/inferno_service ./service/inferno_service
RUN pip install --no-cache-dir ./service

# The built frontend, and the variable that tells the service to serve it.
# Unset, the service behaves exactly as it does on a desktop install.
COPY --from=web /build/out /app/web
ENV INFERNO_WEB_ROOT=/app/web

# Everything that must outlive the container goes under /data, which is the one
# path a deployment has to mount. Downloads are scratch space here - the job
# writes them, the storage layer uploads them - but they are on the volume all
# the same, because a 4K download that vanishes on restart is worse than one
# that takes disk.
ENV DOWNLOAD_DIR=/data/downloads \
    INFERNO_CONFIG_FILE=/data/inferno-settings.json \
    PYTHONUNBUFFERED=1

# Run as nobody. yt-dlp executes extractor code from the open internet, and
# there is no reason for that to happen as uid 0.
RUN mkdir -p /data/downloads \
 && useradd --system --create-home --uid 10001 inferno \
 && chown -R inferno:inferno /data /app
USER inferno

VOLUME ["/data"]
EXPOSE 8765

# `--host 0.0.0.0` is the one argument that must differ from the desktop
# sidecar: the service defaults to 127.0.0.1, which inside a container means
# nothing outside it can connect, including Docker's own port forwarding.
CMD ["python", "-m", "inferno_service", "--host", "0.0.0.0", "--port", "8765"]

# Distinguishes "the container is up" from "the service is answering". The
# service's own /health resolves binaries on the way through, so a broken
# ffmpeg install shows up here rather than on someone's first download.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=4).status==200 else 1)"
