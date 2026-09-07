"""A command-line client for the service.

It is an ordinary consumer of the public API: HTTP for actions, websocket for
progress. Nothing here imports the server's internals, which is the point:
anything this can do, a third-party tool can do the same way (SPEC section 1).

Kept ASCII-only because argparse prints this docstring to the console, and a
Windows codepage that cannot encode it would turn --help into a crash.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Sequence

import httpx

DEFAULT_BASE_URL = os.environ.get("INFERNO_URL", "http://127.0.0.1:8765")


class ApiError(RuntimeError):
    """A coded error from the service (SPEC section 10)."""

    def __init__(self, code: str, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.detail = detail or {}


class Client:
    """Thin wrapper over the REST surface."""

    def __init__(self, base_url: str = DEFAULT_BASE_URL, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        headers = {"X-API-Key": token} if token else {}
        self._http = httpx.Client(base_url=self.base_url, headers=headers, timeout=120.0)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self._http.request(method, path, **kwargs)
        if response.status_code == 204:
            return None
        try:
            payload = response.json()
        except ValueError:
            response.raise_for_status()
            return response.content
        if response.status_code >= 400:
            error = (payload or {}).get("error") or {}
            raise ApiError(
                error.get("code", "unknown"),
                error.get("message", response.text),
                error.get("detail"),
            )
        return payload

    # --- endpoints ---------------------------------------------------------

    def health(self) -> Any:
        return self._request("GET", "/health")

    def info(self, url: str, playlist: bool = False, refresh: bool = False) -> Any:
        return self._request(
            "GET", "/api/v1/info", params={"url": url, "playlist": playlist, "refresh": refresh}
        )

    def formats(self, url: str) -> Any:
        return self._request("GET", "/api/v1/formats", params={"url": url})

    def subtitles(self, url: str) -> Any:
        return self._request("GET", "/api/v1/subtitles", params={"url": url})

    def create_download(self, body: dict[str, Any]) -> Any:
        return self._request("POST", "/api/v1/downloads", json=body)

    def jobs(self, status: str | None = None, limit: int | None = None) -> Any:
        params: dict[str, Any] = {}
        if status:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", "/api/v1/downloads", params=params)

    def job(self, job_id: str) -> Any:
        return self._request("GET", f"/api/v1/downloads/{job_id}")

    def cancel(self, job_id: str) -> Any:
        return self._request("POST", f"/api/v1/downloads/{job_id}/cancel")

    def delete(self, job_id: str, keep_files: bool = False) -> Any:
        return self._request(
            "DELETE", f"/api/v1/downloads/{job_id}", params={"keep_files": keep_files}
        )

    def fetch_file(self, job_id: str, name: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._http.stream(
            "GET", f"/api/v1/downloads/{job_id}/files/{name}"
        ) as response:
            if response.status_code >= 400:
                response.read()
                error = (response.json() or {}).get("error") or {}
                raise ApiError(error.get("code", "unknown"), error.get("message", ""))
            with destination.open("wb") as handle:
                for chunk in response.iter_bytes(64 * 1024):
                    handle.write(chunk)
        return destination

    @property
    def ws_base(self) -> str:
        if self.base_url.startswith("https://"):
            return "wss://" + self.base_url[len("https://") :]
        if self.base_url.startswith("http://"):
            return "ws://" + self.base_url[len("http://") :]
        return self.base_url


# --- progress rendering -----------------------------------------------------


def _human_bytes(value: float | None) -> str:
    if not value:
        return "-"
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} B"


# --- the three stages a person actually sees -------------------------------
#
# The server reports progress per stream, because that is what yt-dlp does: on a
# video+audio merge, percent runs 0->100 twice and the two passes are told apart
# by format_id (SPEC section 5). Rendering that raw gives a bar that fills twice,
# which reads as a bug even though the data is correct.
#
# Presentation is the client's job (SPEC section 1), so the client collapses it
# into three stages and sums bytes across streams for the middle one.

STAGE_PREPARING = "preparing"
STAGE_DOWNLOADING = "downloading"
STAGE_PROCESSING = "processing"
STAGE_DONE = "done"

STAGE_ORDER = (STAGE_PREPARING, STAGE_DOWNLOADING, STAGE_PROCESSING)

STAGE_FOR_STATUS = {
    "queued": STAGE_PREPARING,
    "extracting": STAGE_PREPARING,
    "downloading": STAGE_DOWNLOADING,
    "postprocessing": STAGE_PROCESSING,
    "completed": STAGE_DONE,
    "failed": STAGE_DONE,
    "cancelled": STAGE_DONE,
}

_BAR_WIDTH = 28
#: Width of the block that slides along an indeterminate bar.
_MARKER = "==="


class DownloadProgress:
    """Collapses a job's event stream into three stages with one honest bar.

    Only the download stage has a meaningful percentage. Extraction has no
    measurable total, and ffmpeg reports no percentage at all, so those two
    stages are deliberately indeterminate rather than faked.

    The download stage is weighted **by stream, not by bytes**. Byte-weighting
    cannot be monotonic here: the audio stream's size is unknown until it
    starts, and on real YouTube it is a large share of the job (a 15 MB video
    with 10 MB of audio is ordinary), so learning it late drags the bar
    backwards by tens of points. Instead each expected stream owns an equal
    slice of the bar — with a merge, video fills 0-50% and audio fills 50-100%.

    How many streams to expect comes from the job's resolved options: a merging
    selector means two. A high-water mark then guarantees the bar can never go
    backwards even if that expectation turns out wrong.
    """

    def __init__(self) -> None:
        self.stage = STAGE_PREPARING
        self.status = "queued"
        self.streams: dict[str, dict[str, Any]] = {}
        self.note = "waiting for a slot"
        self.speed: float | None = None
        self.eta: int | None = None
        self.tick = 0
        self._expected = 1
        self._high_water = 0.0

    # --- ingest ------------------------------------------------------------

    def on_job(self, job: dict[str, Any] | None) -> None:
        """Learn how many streams to expect from the job's resolved options."""
        options = (job or {}).get("options") or {}
        self._expected = 2 if options.get("merging") else 1

    def on_status(self, status: str | None) -> None:
        if not status:
            return
        self.status = status
        self.stage = STAGE_FOR_STATUS.get(status, self.stage)
        if status == "extracting":
            self.note = "reading metadata and choosing formats"
        elif status == "downloading":
            self.note = "starting"
        elif status == "postprocessing":
            self.note = "merging and embedding"
            self.speed = self.eta = None
        self._refresh()

    def _stream(self, format_id: str | None) -> dict[str, Any]:
        key = format_id or "?"
        return self.streams.setdefault(key, {"downloaded": 0, "total": 0, "done": False})

    def on_progress(self, data: dict[str, Any]) -> None:
        stream = self._stream(data.get("format_id"))
        # Monotonic per stream: a retried fragment must not walk the bar back.
        stream["downloaded"] = max(stream["downloaded"], data.get("downloaded_bytes") or 0)
        total = data.get("total_bytes") or data.get("total_bytes_estimate")
        if total:
            stream["total"] = max(stream["total"], int(total))
        self.speed = data.get("speed")
        self.eta = data.get("eta")
        # ASCII only: this is written straight to a console that may be cp1252.
        self.note = (
            f"stream {len(self.streams)}/{self.expected_streams} "
            f"(format {data.get('format_id') or '?'})"
        )
        self._refresh()

    def on_finished(self, data: dict[str, Any]) -> None:
        stream = self._stream(data.get("format_id"))
        stream["downloaded"] = max(stream["downloaded"], data.get("downloaded_bytes") or 0)
        stream["total"] = max(stream["total"], stream["downloaded"])
        stream["done"] = True
        self._refresh()

    def on_postprocessor(self, data: dict[str, Any]) -> None:
        name = data.get("postprocessor") or "postprocessor"
        self.note = f"{name} {data.get('status') or ''}".strip()

    # --- derived -----------------------------------------------------------

    @property
    def downloaded(self) -> int:
        return sum(int(s["downloaded"]) for s in self.streams.values())

    @property
    def total(self) -> int:
        return sum(int(s["total"]) for s in self.streams.values())

    @property
    def stream_count(self) -> int:
        return len(self.streams)

    @property
    def expected_streams(self) -> int:
        """Never fewer than we have actually seen, whatever the options said."""
        return max(self._expected, len(self.streams), 1)

    def _refresh(self) -> None:
        """Advance the high-water mark. The bar only ever moves forwards."""
        if self.stage != STAGE_DOWNLOADING or not self.streams:
            return
        finished = sum(1 for s in self.streams.values() if s["done"])
        active = 0.0
        for stream in self.streams.values():
            if not stream["done"] and stream["total"]:
                active = max(active, stream["downloaded"] / stream["total"])
        share = (finished + active) / self.expected_streams * 100.0
        # Never claim 100% while the stage is still running: the audio stream
        # of a merge only appears after the video stream has finished.
        self._high_water = max(self._high_water, min(share, 99.9))

    @property
    def percent(self) -> float | None:
        """Percent for the download stage, or ``None`` when indeterminate."""
        if self.stage == STAGE_DONE:
            return 100.0 if self.status == "completed" else None
        if self.stage != STAGE_DOWNLOADING or not self.streams:
            return None
        # Nothing measurable yet: a stream is running but has reported no total
        # and none has completed. A determinate 0% would just look stuck.
        if not any(s["total"] or s["done"] for s in self.streams.values()):
            return None
        return self._high_water

    @property
    def stage_index(self) -> int:
        return STAGE_ORDER.index(self.stage) + 1 if self.stage in STAGE_ORDER else len(STAGE_ORDER)

    def render(self) -> str:
        self.tick += 1
        label = f"{self.stage_index}/3 {self.stage}"
        percent = self.percent

        if percent is None and self.stage == STAGE_DONE:
            # Failed or cancelled: leave the bar stalled at what was achieved
            # rather than spinning an indeterminate marker forever.
            percent = self._high_water

        if percent is None:
            # An indeterminate stage: a marker that slides, never a fraction.
            span = _BAR_WIDTH - len(_MARKER)
            position = self.tick % span
            bar = "-" * position + _MARKER + "-" * (span - position)
            return f"{label:<16} [{bar}]  {self.note}"

        filled = int(percent / 100 * _BAR_WIDTH)
        bar = "#" * filled + "-" * (_BAR_WIDTH - filled)
        pieces = [
            f"{label:<16} [{bar}] {percent:5.1f}%",
            f"{_human_bytes(self.downloaded)}/{_human_bytes(self.total)}",
        ]
        if self.speed:
            pieces.append(f"{_human_bytes(self.speed)}/s")
        if self.eta is not None:
            pieces.append(f"eta {self.eta}s")
        pieces.append(self.note)
        return "  ".join(pieces)


def _paint(line: str) -> None:
    sys.stdout.write("\r\033[K" + line)
    sys.stdout.flush()


async def _watch(ws_url: str, *, quiet: bool = False) -> dict[str, Any] | None:
    """Follow a job socket to its terminal event. Returns the final job."""
    import websockets

    terminal = {"job.completed", "job.failed", "job.cancelled"}
    status_events = {
        "job.queued",
        "job.extracting",
        "job.downloading",
        "job.postprocessing",
    }
    progress = DownloadProgress()

    async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as socket:
        async for raw in socket:
            frame = json.loads(raw)
            kind = frame.get("type")
            data = frame.get("data") or {}

            if kind == "job.snapshot":
                job = data.get("job") or {}
                if data.get("replay_truncated"):
                    print("! replay truncated: some events were dropped from the buffer")
                # The resolved options say whether a merge is coming, which is
                # how the bar knows to reserve half of itself for the audio pass.
                progress.on_job(job)
                progress.on_status(job.get("status"))
                if not quiet:
                    print(f"job {job.get('job_id')} [{job.get('status')}] {job.get('url')}")
                    print(f"  format: {(job.get('options') or {}).get('format')}")
            elif kind in status_events:
                progress.on_status(data.get("status"))
            elif kind == "progress":
                progress.on_progress(data)
            elif kind == "progress.finished":
                progress.on_finished(data)
            elif kind == "postprocessor":
                progress.on_postprocessor(data)
            elif kind == "log" and data.get("level") in {"warning", "error"}:
                if not quiet:
                    _paint("")
                    print(f"  [{data.get('level')}] {data.get('message')}")
            elif kind in terminal:
                progress.on_status(data.get("status"))
                if not quiet:
                    _paint(progress.render())
                    print()
                if kind == "job.completed":
                    print(f"completed in {data.get('elapsed')}s")
                    for entry in data.get("files") or []:
                        print(f"  {entry['name']}  ({_human_bytes(entry['size'])})")
                elif kind == "job.failed":
                    error = data.get("error") or {}
                    print(f"failed: {error.get('code')}: {error.get('message')}")
                else:
                    print("cancelled")
                return data
            else:
                continue

            if not quiet and kind != "job.snapshot":
                _paint(progress.render())
    return None


async def _watch_firehose(ws_url: str) -> None:
    import websockets

    async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as socket:
        async for raw in socket:
            frame = json.loads(raw)
            if frame.get("type") == "heartbeat":
                continue
            print(
                f"seq={frame.get('seq')} {frame.get('type')} "
                f"job={frame.get('job_id')} {json.dumps(frame.get('data'), default=str)[:160]}"
            )


# --- commands ---------------------------------------------------------------


def _emit(payload: Any, as_json: bool = True) -> None:
    print(json.dumps(payload, indent=2, default=str) if as_json else payload)


def _cmd_health(client: Client, args: argparse.Namespace) -> int:
    health = client.health()
    if args.json:
        _emit(health)
        return 0
    print(f"status         {health['status']}  (service {health['version']})")
    print(f"yt-dlp         {health.get('yt_dlp_version')}")
    for name in ("ffmpeg", "ffprobe"):
        entry = health.get(name) or {}
        mark = "ok " if entry.get("available") else "MISSING"
        print(f"{name:<14} {mark} source={entry.get('source')} {entry.get('path') or ''}")
    js = health.get("js_runtime") or {}
    mark = "ok " if js.get("available") else "MISSING"
    print(f"{'js_runtime':<14} {mark} {js.get('name')} {js.get('version') or ''} source={js.get('source')}")
    print(f"cookies        {health.get('cookies')}")
    print(f"max_concurrent {health.get('max_concurrent')}")
    print(f"jobs           {health.get('jobs')}")
    return 0


def _cmd_info(client: Client, args: argparse.Namespace) -> int:
    payload = client.info(args.url, playlist=args.playlist, refresh=args.refresh)
    if args.json:
        _emit(payload)
        return 0
    if payload.get("playlist"):
        playlist = payload["playlist"]
        print(f"playlist: {playlist.get('title')}  ({playlist.get('count')} entries)")
        for entry in playlist.get("entries", [])[:50]:
            print(f"  {entry.get('id'):<16} {entry.get('title')}")
        return 0
    video = payload.get("video") or {}
    print(f"{video.get('title')}")
    print(f"  id         {video.get('id')}")
    print(f"  uploader   {video.get('uploader')}")
    print(f"  duration   {video.get('duration')}s")
    print(f"  uploaded   {video.get('upload_date')}")
    print(f"  formats    {len(video.get('formats') or [])}")
    print(f"  cached     {payload.get('cached')}")
    return 0


def _cmd_formats(client: Client, args: argparse.Namespace) -> int:
    payload = client.formats(args.url)
    if args.json:
        _emit(payload)
        return 0
    print(f"{payload.get('title')}\n")
    header = f"{'id':<16}{'ext':<6}{'res':<12}{'fps':>5}  {'size':>12}  {'vcodec':<14}{'acodec':<14}note"
    print(header)
    print("-" * len(header))
    for fmt in payload.get("formats", []):
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        print(
            f"{str(fmt.get('format_id')):<16}{str(fmt.get('ext') or ''):<6}"
            f"{str(fmt.get('resolution') or ''):<12}{str(fmt.get('fps') or ''):>5}  "
            f"{_human_bytes(size):>12}  {str(fmt.get('vcodec') or ''):<14}"
            f"{str(fmt.get('acodec') or ''):<14}{fmt.get('format_note') or ''}"
        )
    return 0


def _cmd_subtitles(client: Client, args: argparse.Namespace) -> int:
    payload = client.subtitles(args.url)
    if args.json:
        _emit(payload)
        return 0
    for label in ("subtitles", "automatic_captions"):
        tracks = payload.get(label) or {}
        print(f"{label}: {len(tracks)} languages")
        for language, entries in sorted(tracks.items()):
            formats = ",".join(sorted({str(e.get('ext')) for e in entries if e.get('ext')}))
            print(f"  {language:<10} {formats}")
    return 0


def _cmd_download(client: Client, args: argparse.Namespace) -> int:
    body: dict[str, Any] = {
        "url": args.url,
        "mode": args.mode,
        "quality": args.quality,
        "playlist": args.playlist,
        "embed_thumbnail": not args.no_embed_thumbnail,
        "embed_metadata": not args.no_embed_metadata,
    }
    if args.format_id:
        body["format_id"] = args.format_id
    if args.audio_format:
        body["audio_format"] = args.audio_format
    if args.audio_quality is not None:
        body["audio_quality"] = args.audio_quality
    if args.container:
        body["container"] = args.container
    if args.subtitles:
        body["subtitles"] = args.subtitles
        body["embed_subtitles"] = args.embed_subtitles
    if args.auto_subtitles:
        body["auto_subtitles"] = True
    if args.output_template:
        body["output_template"] = args.output_template
    if args.rate_limit:
        body["rate_limit"] = args.rate_limit
    if args.concurrent_fragments:
        body["concurrent_fragments"] = args.concurrent_fragments

    job = client.create_download(body)
    if args.json:
        _emit(job)
        return 0

    print(f"queued {job['job_id']}  ->  {job['ws_url']}")
    if args.no_watch:
        return 0

    ws_url = job["ws_url"]
    if client.token:
        ws_url = f"{ws_url}?token={client.token}"
    final = asyncio.run(_watch(ws_url))
    if final and final.get("status") == "failed":
        return 1
    if args.output_dir and final and final.get("status") == "completed":
        target = Path(args.output_dir)
        for entry in final.get("files") or []:
            saved = client.fetch_file(job["job_id"], entry["name"], target / entry["name"])
            print(f"saved {saved}")
    return 0


def _cmd_jobs(client: Client, args: argparse.Namespace) -> int:
    payload = client.jobs(status=args.status, limit=args.limit)
    if args.json:
        _emit(payload)
        return 0
    print(f"{'job_id':<18}{'status':<16}{'elapsed':>9}  url")
    for job in payload.get("jobs", []):
        elapsed = job.get("elapsed")
        print(
            f"{job['job_id']:<18}{job['status']:<16}"
            f"{(f'{elapsed:.1f}' if elapsed is not None else '-'):>9}  {job['url'][:70]}"
        )
    print(f"\n{payload.get('count')} of {payload.get('total')}")
    return 0


def _cmd_job(client: Client, args: argparse.Namespace) -> int:
    _emit(client.job(args.job_id))
    return 0


def _cmd_cancel(client: Client, args: argparse.Namespace) -> int:
    job = client.cancel(args.job_id)
    print(f"{job['job_id']} -> {job['status']}")
    return 0


def _cmd_rm(client: Client, args: argparse.Namespace) -> int:
    client.delete(args.job_id, keep_files=args.keep_files)
    print(f"deleted {args.job_id}")
    return 0


def _cmd_get(client: Client, args: argparse.Namespace) -> int:
    destination = Path(args.output or ".") / Path(args.name).name
    saved = client.fetch_file(args.job_id, args.name, destination)
    print(f"saved {saved} ({saved.stat().st_size} bytes)")
    return 0


def _cmd_watch(client: Client, args: argparse.Namespace) -> int:
    suffix = f"?token={client.token}" if client.token else ""
    if args.job_id:
        asyncio.run(_watch(f"{client.ws_base}/ws/downloads/{args.job_id}{suffix}"))
    else:
        asyncio.run(_watch_firehose(f"{client.ws_base}/ws/events{suffix}"))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="inferno-cli", description=__doc__)
    parser.add_argument("--url-base", default=DEFAULT_BASE_URL, help="Service base URL.")
    parser.add_argument("--token", default=os.environ.get("API_TOKEN"), help="API token.")
    parser.add_argument("--json", action="store_true", help="Print raw JSON.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="Show capabilities and versions.").set_defaults(fn=_cmd_health)

    info = sub.add_parser("info", help="Normalised metadata for a URL.")
    info.add_argument("url")
    info.add_argument("--playlist", action="store_true")
    info.add_argument("--refresh", action="store_true")
    info.set_defaults(fn=_cmd_info)

    formats = sub.add_parser("formats", help="The format table.")
    formats.add_argument("url")
    formats.set_defaults(fn=_cmd_formats)

    subs = sub.add_parser("subtitles", help="Caption track listing.")
    subs.add_argument("url")
    subs.set_defaults(fn=_cmd_subtitles)

    download = sub.add_parser("download", help="Queue a download and follow it.")
    download.add_argument("url")
    download.add_argument("--mode", choices=["video", "audio"], default="video")
    download.add_argument(
        "--quality",
        default="best",
        choices=["best", "4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p", "worst"],
    )
    download.add_argument("--format-id", dest="format_id")
    download.add_argument(
        "--audio-format",
        dest="audio_format",
        choices=["best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav"],
    )
    download.add_argument("--audio-quality", dest="audio_quality", type=int)
    download.add_argument("--container", choices=["mp4", "mkv", "webm", "mov", "flv", "avi"])
    download.add_argument("--playlist", action="store_true")
    download.add_argument("--subtitles", nargs="*", default=None, metavar="LANG")
    download.add_argument("--auto-subtitles", dest="auto_subtitles", action="store_true")
    download.add_argument("--embed-subtitles", dest="embed_subtitles", action="store_true")
    download.add_argument("--no-embed-thumbnail", dest="no_embed_thumbnail", action="store_true")
    download.add_argument("--no-embed-metadata", dest="no_embed_metadata", action="store_true")
    download.add_argument("--output-template", dest="output_template")
    download.add_argument("--concurrent-fragments", dest="concurrent_fragments", type=int)
    download.add_argument("--rate-limit", dest="rate_limit", type=int, metavar="BYTES_PER_SEC")
    download.add_argument("--no-watch", dest="no_watch", action="store_true")
    download.add_argument("-o", "--output-dir", dest="output_dir", help="Fetch files here when done.")
    download.set_defaults(fn=_cmd_download)

    jobs = sub.add_parser("jobs", help="List jobs.")
    jobs.add_argument("--status")
    jobs.add_argument("--limit", type=int)
    jobs.set_defaults(fn=_cmd_jobs)

    job = sub.add_parser("job", help="Show one job.")
    job.add_argument("job_id")
    job.set_defaults(fn=_cmd_job)

    cancel = sub.add_parser("cancel", help="Cancel a job.")
    cancel.add_argument("job_id")
    cancel.set_defaults(fn=_cmd_cancel)

    remove = sub.add_parser("rm", help="Cancel and delete a job.")
    remove.add_argument("job_id")
    remove.add_argument("--keep-files", dest="keep_files", action="store_true")
    remove.set_defaults(fn=_cmd_rm)

    get = sub.add_parser("get", help="Download a finished file through the API.")
    get.add_argument("job_id")
    get.add_argument("name")
    get.add_argument("-o", "--output", help="Target directory.")
    get.set_defaults(fn=_cmd_get)

    watch = sub.add_parser("watch", help="Follow one job, or the firehose.")
    watch.add_argument("job_id", nargs="?")
    watch.set_defaults(fn=_cmd_watch)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        with Client(args.url_base, args.token) as client:
            return int(args.fn(client, args))
    except ApiError as exc:
        print(f"error [{exc.code}] {exc.message}", file=sys.stderr)
        if exc.detail:
            print(json.dumps(exc.detail, indent=2, default=str), file=sys.stderr)
        return 2
    except httpx.HTTPError as exc:
        print(f"cannot reach the service at {args.url_base}: {exc}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
