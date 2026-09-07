"""Job registry, concurrency cap, yt-dlp execution and cancellation (SPEC §6).

The lifecycle is::

    queued -> extracting -> downloading -> postprocessing -> completed
                         -> failed
                         -> cancelled

Two things deserve attention.

**Cancellation is responsive mid-download, not merely between jobs.** Each job
owns a :class:`threading.Event` that the progress hook checks on every tick; when
it is set the hook raises yt-dlp's ``DownloadCancelled``, which unwinds the
blocking download from the inside.

**Nothing here touches the event loop directly.** yt-dlp calls its hooks on its
own worker thread, so every mutation of job state and every event is handed to
:meth:`EventBus.run_on_loop`, which is the one place the boundary is crossed.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import quote

from .binaries import BinaryResolver
from .config import Settings
from .errors import ErrorCode, ServiceError, classify_exception
from .events import EventBus, EventType, job_channel
from .extract import is_playlist, normalise_playlist, normalise_video, validate_url
from .options import Resolution, resolve as resolve_options
from .schemas import TERMINAL_STATUSES, DownloadRequest
from . import ytdlp

__all__ = ["Job", "JobManager", "JobStatus"]

#: Suffixes yt-dlp leaves behind mid-flight; never reported as finished files.
_TRANSIENT_SUFFIXES = (".part", ".ytdl", ".temp", ".tmp")

#: Staging lives under the download folder so publishing is a rename rather
#: than a copy. Dot-prefixed so it sorts and hides out of the way.
_STAGING_DIR = ".incomplete"

#: `video (3).mp4` -> stem `video`, index 3. Used to keep numbering tidy when
#: a name that already carries a suffix collides again.
_NUMBERED = re.compile(r"^(?P<stem>.*) \((?P<index>\d+)\)$")

log = logging.getLogger(__name__)


def _hide(path: Path) -> None:
    """Mark the staging folder hidden.

    A leading dot hides a directory on Unix but means nothing on Windows, and
    this one sits in the user's own download folder - so without the attribute
    they get a stray `.incomplete` beside their videos.
    """
    if os.name != "nt":
        return
    try:
        import ctypes

        FILE_ATTRIBUTE_HIDDEN = 0x02
        ctypes.windll.kernel32.SetFileAttributesW(str(path), FILE_ATTRIBUTE_HIDDEN)
    except Exception:  # noqa: BLE001 - cosmetic only, never worth failing a job
        pass


def _is_transient(path: Path) -> bool:
    """Fragments and part-files, which are rubble rather than output."""
    return path.suffix.lower() in _TRANSIENT_SUFFIXES or ".part-Frag" in path.name


def _cased(stem: str, style: str) -> str:
    """Apply a naming style to a file's stem, leaving its extension alone.

    yt-dlp's output template cannot do this - it has truncation and date
    formatting but no case conversion - so it happens here, at the one moment
    the finished file is renamed anyway.

    Applied to the whole stem rather than per field, which is what keeps it
    consistent: `Channel - Title` in kebab-case should be one hyphenated run,
    not two cased fragments joined by a stray dash.
    """
    if style == "original" or not stem:
        return stem
    if style == "lower":
        return stem.lower()
    if style == "title":
        return " ".join(word[:1].upper() + word[1:].lower() for word in stem.split(" "))

    separator = "-" if style == "kebab" else "_"
    lowered = re.sub(r"[^a-zA-Z0-9]+", separator, stem.lower())

    return lowered.strip(separator) or stem


def _unique_path(target: Path) -> Path:
    """`video.mp4`, then `video (1).mp4`, then `video (2).mp4`.

    Mirrors what browsers and file managers do, so the result is what someone
    expects to find rather than a surprise. Never overwrites.
    """
    if not target.exists():
        return target

    stem, suffix = target.stem, target.suffix
    # Re-downloading `video (1).mp4` should give `video (2).mp4`, not
    # `video (1) (1).mp4`.
    match = _NUMBERED.match(stem)
    if match:
        stem = match.group("stem")

    index = 1
    while True:
        candidate = target.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate
        index += 1


def _describe_file(job_id: str, path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "mime": mimetypes.guess_type(path.name)[0],
        "modified": stat.st_mtime,
        "url": f"/api/v1/downloads/{job_id}/files/{quote(path.name)}",
        # Absolute, for a local client that wants to open or reveal the file.
        # Reading it still goes through ``url``.
        "path": str(path),
    }


class JobStatus:
    QUEUED = "queued"
    EXTRACTING = "extracting"
    DOWNLOADING = "downloading"
    POSTPROCESSING = "postprocessing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


_STATUS_EVENT = {
    JobStatus.QUEUED: EventType.JOB_QUEUED,
    JobStatus.EXTRACTING: EventType.JOB_EXTRACTING,
    JobStatus.DOWNLOADING: EventType.JOB_DOWNLOADING,
    JobStatus.POSTPROCESSING: EventType.JOB_POSTPROCESSING,
    JobStatus.COMPLETED: EventType.JOB_COMPLETED,
    JobStatus.FAILED: EventType.JOB_FAILED,
    JobStatus.CANCELLED: EventType.JOB_CANCELLED,
}


@dataclass
class Job:
    """One download job (SPEC §6)."""

    job_id: str
    url: str
    directory: Path
    resolution: Resolution
    #: Final locations after publishing. Empty until the job completes.
    published: list[Path] = field(default_factory=list)
    #: How the finished file's name is cased. Kept on the job because it is
    #: applied at publish time - yt-dlp's output template has no case
    #: conversion, so it cannot travel with the rest of the options.
    filename_case: str = "original"
    status: str = JobStatus.QUEUED
    video: dict[str, Any] | None = None
    playlist: dict[str, Any] | None = None
    progress: dict[str, Any] | None = None
    files: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task[Any] | None = None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def elapsed(self) -> float | None:
        if self.started_at is None:
            return None
        end = self.finished_at if self.finished_at is not None else time.time()
        return round(end - self.started_at, 3)

    def to_dict(self, ws_base: str | None = None) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "url": self.url,
            "status": self.status,
            # SPEC §6: echo back resolved options, not the ones sent.
            "options": self.resolution.summary,
            # Where the files landed, for "reveal in folder" (SPEC §4.5).
            # The download folder itself once published, not the staging
            # folder the job used while it ran.
            "directory": str(
                self.published[0].parent if self.published else self.directory
            ),
            "video": self.video,
            "playlist": self.playlist,
            "progress": self.progress,
            "files": list(self.files),
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed": self.elapsed,
            "ws_url": f"{ws_base}/ws/downloads/{self.job_id}" if ws_base else None,
        }

    def snapshot(self) -> dict[str, Any]:
        """The payload of the first frame on a job socket."""
        return self.to_dict()


class _JobLogger:
    """Routes yt-dlp's own output onto the bus as ``log`` events (SPEC §5)."""

    def __init__(self, events: EventBus, job_id: str) -> None:
        self._events = events
        self._job_id = job_id

    def _emit(self, level: str, message: Any) -> None:
        text = str(message)
        if not text.strip():
            return
        self._events.publish_threadsafe(
            EventType.LOG, self._job_id, {"level": level, "message": text}
        )

    def debug(self, message: Any) -> None:
        # yt-dlp routes plain stdout through debug() prefixed with '[debug] '.
        text = str(message)
        self._emit("debug" if text.startswith("[debug] ") else "info", text)

    def info(self, message: Any) -> None:
        self._emit("info", message)

    def warning(self, message: Any) -> None:
        self._emit("warning", message)

    def error(self, message: Any) -> None:
        self._emit("error", message)


def _progress_payload(status: Mapping[str, Any]) -> dict[str, Any]:
    """Map a yt-dlp progress dict onto the SPEC §5 ``progress.data`` shape."""
    downloaded = status.get("downloaded_bytes")
    total = status.get("total_bytes")
    estimate = status.get("total_bytes_estimate")
    denominator = total if total else estimate
    percent = None
    if denominator and downloaded is not None:
        try:
            percent = round(min(100.0, float(downloaded) / float(denominator) * 100.0), 2)
        except (TypeError, ValueError, ZeroDivisionError):
            percent = None

    info = status.get("info_dict") or {}
    filename = status.get("filename") or info.get("filepath")
    return {
        "status": status.get("status"),
        "downloaded_bytes": _int_or_none(downloaded),
        "total_bytes": _int_or_none(total),
        "total_bytes_estimate": _int_or_none(estimate),
        "percent": percent,
        "speed": _float_or_none(status.get("speed")),
        "eta": _int_or_none(status.get("eta")),
        "elapsed": _float_or_none(status.get("elapsed")),
        "fragment_index": _int_or_none(status.get("fragment_index")),
        "fragment_count": _int_or_none(status.get("fragment_count")),
        "filename": Path(filename).name if filename else None,
        # Percent restarts between streams on a merge; format_id is how a client
        # tells the two passes apart (SPEC §5).
        "format_id": info.get("format_id"),
        "ext": info.get("ext"),
        # *Which* pass this is. A client showing a bar per stream cannot label
        # them from arrival order - that is a yt-dlp implementation detail, and
        # getting it backwards labels the small audio stream "video", which
        # then appears to finish instantly. The codecs say it outright.
        "vcodec": info.get("vcodec"),
        "acodec": info.get("acodec"),
    }


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class _ConcurrencyGate:
    """A semaphore whose limit can change while jobs are in flight.

    ``asyncio.Semaphore`` cannot be resized, and restarting the service to move
    a concurrency slider would kill every running download. Raising the limit
    wakes waiting jobs immediately; lowering it lets the extra jobs finish and
    simply admits nobody new until the count falls back under the cap.
    """

    def __init__(self, limit: int) -> None:
        self._limit = max(1, limit)
        self._active = 0
        self._condition = asyncio.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def active(self) -> int:
        return self._active

    async def __aenter__(self) -> "_ConcurrencyGate":
        async with self._condition:
            while self._active >= self._limit:
                await self._condition.wait()
            self._active += 1
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        async with self._condition:
            self._active -= 1
            self._condition.notify_all()
        return False

    async def set_limit(self, limit: int) -> None:
        async with self._condition:
            self._limit = max(1, limit)
            self._condition.notify_all()


class JobManager:
    """Owns every job, the concurrency cap, and the retention sweep."""

    def __init__(
        self,
        settings: Settings,
        binaries: BinaryResolver,
        events: EventBus,
    ) -> None:
        self._settings = settings
        self._binaries = binaries
        self._events = events
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._gate = _ConcurrencyGate(settings.max_concurrent)
        self._sweeper: asyncio.Task[None] | None = None
        self._closing = False

    async def apply_settings(self, settings: Settings) -> None:
        """Adopt a new settings snapshot. Running jobs are never interrupted."""
        self._settings = settings
        await self._gate.set_limit(settings.max_concurrent)
        try:
            settings.resolved_download_dir().mkdir(parents=True, exist_ok=True)
        except OSError:  # reported through /health rather than crashing a patch
            pass

    # --- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        self._closing = False
        self._events.bind_loop(asyncio.get_running_loop())
        self._settings.resolved_download_dir().mkdir(parents=True, exist_ok=True)
        if self._settings.job_ttl > 0 and self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep_loop(), name="job-ttl-sweeper")

    async def aclose(self) -> None:
        self._closing = True
        if self._sweeper is not None:
            self._sweeper.cancel()
            try:
                await self._sweeper
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutting down
                pass
            self._sweeper = None

        pending = [job for job in self._jobs.values() if not job.terminal]
        for job in pending:
            job.cancel_event.set()
            if job.task is not None:
                job.task.cancel()
        for job in pending:
            if job.task is not None:
                try:
                    await job.task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutting down
                    pass

    # --- registry ----------------------------------------------------------

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise ServiceError(ErrorCode.JOB_NOT_FOUND, f"No job with id {job_id!r}.", {"job_id": job_id})
        return job

    def list(self, status: str | None = None, limit: int | None = None) -> tuple[list[Job], int]:
        """Newest first. Returns ``(page, total_matching)``."""
        jobs = [self._jobs[jid] for jid in reversed(self._order) if jid in self._jobs]
        if status:
            jobs = [job for job in jobs if job.status == status]
        total = len(jobs)
        if limit is not None and limit >= 0:
            jobs = jobs[:limit]
        return jobs, total

    def counts(self) -> dict[str, int]:
        counts = {
            name: 0
            for name in (
                JobStatus.QUEUED,
                JobStatus.EXTRACTING,
                JobStatus.DOWNLOADING,
                JobStatus.POSTPROCESSING,
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
            )
        }
        for job in self._jobs.values():
            counts[job.status] = counts.get(job.status, 0) + 1
        counts["total"] = len(self._jobs)
        return counts

    def job_directory(self, job_id: str) -> Path:
        """Where a job downloads *while it runs*.

        Downloads are staged in a hidden per-job folder and only moved into the
        user's download folder once they finish (see ``_publish``). yt-dlp
        writes fragments, `.part` files and pre-merge streams beside the real
        output, so downloading straight into the destination would litter it
        with rubble and expose half-finished files. Staging inside the download
        folder keeps the final move on one filesystem, so it is a rename.
        """
        return self._settings.resolved_download_dir() / _STAGING_DIR / job_id

    def output_directory(self) -> Path:
        """Where finished files end up: the user's download folder itself."""
        return self._settings.resolved_download_dir()

    # --- creating and running ---------------------------------------------

    def create(
        self, request: DownloadRequest, defaults: Mapping[str, Any] | None = None
    ) -> Job:
        """Queue a job. Validation and options resolution happen synchronously,
        so a bad request fails at the API boundary rather than inside a task.

        ``defaults`` are the user's download preferences. Only fields the client
        did not explicitly send are taken from them, so a client can post just a
        URL and still get the configured quality, or override any single field
        without having to restate the rest.
        """
        if defaults:
            supplied = request.model_dump(exclude_unset=True)
            request = DownloadRequest(**{**dict(defaults), **supplied})

        url = validate_url(request.url)
        job_id = uuid.uuid4().hex[:16]
        directory = self.job_directory(job_id)

        # SPEC §7 and §10: resolve options and preflight before anything runs.
        resolution = resolve_options(request, self._settings, self._binaries, directory)

        directory.mkdir(parents=True, exist_ok=True)
        _hide(directory.parent)
        job = Job(
            job_id=job_id,
            url=url,
            directory=directory,
            resolution=resolution,
            filename_case=request.filename_case,
        )
        self._jobs[job_id] = job
        self._order.append(job_id)

        self._events.publish(EventType.JOB_QUEUED, job_id, {"job": job.to_dict()})
        job.task = asyncio.create_task(self._run(job), name=f"job-{job_id}")
        return job

    async def _run(self, job: Job) -> None:
        try:
            async with self._gate:
                if job.cancel_event.is_set():
                    self._finish(job, JobStatus.CANCELLED)
                    return
                job.started_at = time.time()
                self._set_status(job, JobStatus.EXTRACTING)
                info = await asyncio.to_thread(self._blocking_download, job)
        except asyncio.CancelledError:
            if not job.terminal:
                self._finish(job, JobStatus.CANCELLED)
            raise
        except BaseException as exc:  # noqa: BLE001 - everything gets a stable code
            error = classify_exception(exc, context="download")
            if error.code == ErrorCode.CANCELLED:
                self._finish(job, JobStatus.CANCELLED)
            else:
                self._finish(job, JobStatus.FAILED, error=error.to_dict())
            return

        self._apply_info(job, info)
        job.files = await asyncio.to_thread(self._publish, job)
        self._finish(job, JobStatus.COMPLETED)

    def _blocking_download(self, job: Job) -> dict[str, Any] | None:
        """Runs on a worker thread. Never touches the event loop directly."""
        opts = dict(job.resolution.ydl_opts)
        opts["progress_hooks"] = [self._make_progress_hook(job)]
        opts["postprocessor_hooks"] = [self._make_postprocessor_hook(job)]
        opts["logger"] = _JobLogger(self._events, job.job_id)

        with ytdlp.build_ydl(opts) as ydl:
            result = ydl.extract_info(job.url, download=True)
        if job.cancel_event.is_set():
            raise ytdlp.DownloadCancelled("cancelled")
        return dict(result) if isinstance(result, Mapping) else None

    # --- hooks (worker thread) --------------------------------------------

    def _make_progress_hook(self, job: Job):
        def hook(status: Mapping[str, Any]) -> None:
            # Cancellation must bite mid-download, so check on every tick and
            # unwind yt-dlp through its own cancellation exception (SPEC §3).
            if job.cancel_event.is_set():
                raise ytdlp.DownloadCancelled(f"job {job.job_id} cancelled")
            payload = _progress_payload(status)
            self._events.run_on_loop(lambda: self._on_progress(job, payload))

        return hook

    def _make_postprocessor_hook(self, job: Job):
        def hook(status: Mapping[str, Any]) -> None:
            if job.cancel_event.is_set():
                raise ytdlp.DownloadCancelled(f"job {job.job_id} cancelled")
            payload = {
                "status": status.get("status"),
                "postprocessor": status.get("postprocessor"),
                "filename": Path(str(status.get("info_dict", {}).get("filepath") or "")).name or None,
            }
            self._events.run_on_loop(lambda: self._on_postprocessor(job, payload))

        return hook

    # --- loop-side state transitions --------------------------------------

    def _on_progress(self, job: Job, payload: dict[str, Any]) -> None:
        if job.terminal:
            return
        job.progress = payload
        if payload.get("status") == "downloading" and job.status != JobStatus.DOWNLOADING:
            self._set_status(job, JobStatus.DOWNLOADING)

        if payload.get("status") == "finished":
            # One stream finished. On a video+audio merge this fires twice, and
            # a client tells the passes apart by format_id (SPEC §5).
            self._events.reset_throttle(job.job_id)
            self._events.publish(EventType.PROGRESS_FINISHED, job.job_id, payload)
        elif payload.get("status") == "error":
            self._events.publish(EventType.PROGRESS, job.job_id, payload)
        else:
            self._events.publish(EventType.PROGRESS, job.job_id, payload, throttle=True)

    def _on_postprocessor(self, job: Job, payload: dict[str, Any]) -> None:
        if job.terminal:
            return
        if payload.get("status") == "started" and job.status != JobStatus.POSTPROCESSING:
            self._set_status(job, JobStatus.POSTPROCESSING)
        self._events.publish(EventType.POSTPROCESSOR, job.job_id, payload)

    def _set_status(self, job: Job, status: str) -> None:
        job.status = status
        self._events.publish(_STATUS_EVENT[status], job.job_id, {"status": status})

    def _finish(self, job: Job, status: str, error: dict[str, Any] | None = None) -> None:
        if job.terminal:
            return
        job.status = status
        job.finished_at = time.time()
        job.error = error
        self._events.reset_throttle(job.job_id)
        data: dict[str, Any] = {"status": status, "elapsed": job.elapsed}
        if status == JobStatus.COMPLETED:
            data["files"] = list(job.files)
            data["video"] = job.video
        if error is not None:
            data["error"] = error
        self._events.publish(_STATUS_EVENT[status], job.job_id, data)

    def _apply_info(self, job: Job, info: Mapping[str, Any] | None) -> None:
        if not info:
            return
        if is_playlist(info):
            job.playlist = normalise_playlist(info)
        else:
            job.video = normalise_video(info)

    # --- files -------------------------------------------------------------

    def _publish(self, job: Job) -> list[dict[str, Any]]:
        """Move a finished job's files into the download folder.

        Runs on a worker thread: the moves are renames on one filesystem, but
        a fallback copy across devices would block the loop.

        Collisions are resolved the way every other downloader does it - the
        second `video.mp4` becomes `video (1).mp4` - rather than by
        overwriting, which would silently destroy an earlier download, or by
        refusing, which would lose the one just fetched.
        """
        staging = job.directory
        destination = self.output_directory()
        destination.mkdir(parents=True, exist_ok=True)

        style = job.filename_case

        published: list[Path] = []
        for path in sorted(staging.rglob("*")):
            if not path.is_file() or _is_transient(path):
                continue
            # The stem is cased; the suffix is whatever the download actually
            # turned out to be and is never touched.
            name = f"{_cased(path.stem, style)}{path.suffix}"
            target = _unique_path(destination / name)
            try:
                shutil.move(str(path), str(target))
            except OSError:
                # One file failing to move must not lose the rest of the job.
                log.warning("could not publish %s", path, exc_info=True)
                continue
            published.append(target)

        job.published = published
        # Whatever is left is fragments and part-files; the staging folder is
        # the job's own, so removing it cannot touch anything else.
        shutil.rmtree(staging, ignore_errors=True)

        return [_describe_file(job.job_id, path) for path in published]

    def _collect_files(self, job: Job) -> list[dict[str, Any]]:
        directory = job.directory
        if not directory.is_dir():
            return []
        entries: list[dict[str, Any]] = []
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix.lower() in _TRANSIENT_SUFFIXES or ".part-Frag" in path.name:
                continue
            relative = path.relative_to(directory).as_posix()
            stat = path.stat()
            entries.append(
                {
                    "name": relative,
                    "size": stat.st_size,
                    "mime": mimetypes.guess_type(path.name)[0],
                    "modified": stat.st_mtime,
                    "url": f"/api/v1/downloads/{job.job_id}/files/{quote(relative)}",
                    # Absolute, for a local client that wants to open or reveal
                    # the file. Reading it still goes through ``url`` - this is
                    # not a second way to fetch the bytes.
                    "path": str(path),
                }
            )
        return entries

    def resolve_file(self, job: Job, name: str) -> Path:
        """Resolve ``name`` to one of *this job's* files.

        Finished jobs now share one directory, so a path check against that
        directory would happily serve any other download in it. The job's own
        list of published files is the allow-list instead - a name that is not
        on it does not exist as far as this job is concerned.
        """
        for path in job.published:
            if path.name == name and path.is_file():
                return path

        # Still running: the file is in staging, where a containment check is
        # the right test because the folder belongs to this job alone.
        root = job.directory.resolve()
        candidate = (root / name).resolve()
        if root.is_dir():
            try:
                candidate.relative_to(root)
            except ValueError:
                candidate = None  # type: ignore[assignment]
            if candidate is not None and candidate.is_file():
                return candidate

        raise ServiceError(
            ErrorCode.FILE_NOT_FOUND, "No such file for this job.", {"name": name}
        )

    # --- cancel and delete -------------------------------------------------

    async def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.terminal:
            return job
        job.cancel_event.set()
        if job.status == JobStatus.QUEUED and job.task is not None:
            # Still waiting on the concurrency cap; nothing to unwind from inside.
            job.task.cancel()
        # Give the worker a moment to unwind so the caller sees a settled job.
        for _ in range(50):
            if job.terminal:
                break
            await asyncio.sleep(0.02)
        if not job.terminal:
            self._finish(job, JobStatus.CANCELLED)
        return job

    async def delete(self, job_id: str, keep_files: bool = False) -> None:
        job = self.get(job_id)
        if not job.terminal:
            await self.cancel(job_id)
        self._jobs.pop(job_id, None)
        if job_id in self._order:
            self._order.remove(job_id)
        self._events.drop_channel(job_channel(job_id))
        if not keep_files:
            # Published files now live among everyone else's in the shared
            # download folder, so they are removed one by one - never by
            # deleting the folder, which is the user's.
            for path in job.published:
                try:
                    path.unlink()
                except OSError:
                    log.warning("could not delete %s", path, exc_info=True)
            job.published = []
        # The staging folder is this job's alone and holds only rubble once a
        # job is over, so it goes either way.
        shutil.rmtree(job.directory, ignore_errors=True)

    # --- retention ---------------------------------------------------------

    async def _sweep_loop(self) -> None:
        interval = max(5.0, min(60.0, float(self._settings.job_ttl) / 4 or 60.0))
        while not self._closing:
            try:
                await asyncio.sleep(interval)
                self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - a sweep failure must not kill the loop
                continue

    def sweep(self, now: float | None = None) -> list[str]:
        """Drop finished jobs older than ``JOB_TTL``. Returns the ids removed."""
        ttl = self._settings.job_ttl
        if ttl <= 0:
            return []
        moment = time.time() if now is None else now
        expired = [
            job.job_id
            for job in list(self._jobs.values())
            if job.terminal and job.finished_at is not None and (moment - job.finished_at) > ttl
        ]
        for job_id in expired:
            job = self._jobs.pop(job_id, None)
            if job_id in self._order:
                self._order.remove(job_id)
            self._events.drop_channel(job_channel(job_id))
            if job is not None:
                shutil.rmtree(job.directory, ignore_errors=True)
        return expired

    def __iter__(self) -> Iterable[Job]:  # pragma: no cover - convenience
        return iter(self._jobs.values())
