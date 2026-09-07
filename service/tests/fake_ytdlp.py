"""A fake ``YoutubeDL`` that drives the real hooks without touching the network.

The service funnels every construction of a ``YoutubeDL`` through
``inferno_service.ytdlp.build_ydl``. Patching that one function lets the whole
stack — options resolution, the progress hooks, the thread bridge, the event
bus, the websockets, the file routes — run end to end and deterministically.

Behaviour is chosen by the URL path, so a test picks a scenario by asking for
``https://fake.test/<scenario>``.
"""

from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlparse

from yt_dlp.utils import DownloadError

__all__ = ["FakeYoutubeDL", "install", "SCENARIOS", "make_info"]

_TEMPLATE_FIELD = re.compile(r"%\((\w+)\)0?\d*[sdf]")


def make_info(video_id: str = "abc123XYZ_", title: str = "Fake Video") -> dict[str, Any]:
    """A metadata dict shaped like yt-dlp's, trimmed to what we normalise."""
    return {
        "id": video_id,
        "title": title,
        "description": "A description.",
        "uploader": "Fake Uploader",
        "uploader_id": "@fake",
        "channel": "Fake Channel",
        "channel_id": "UC_fake",
        "channel_follower_count": 214000,
        "duration": 213.5,
        "upload_date": "20240115",
        "timestamp": 1705276800,
        "thumbnail": "https://fake.test/thumb.jpg",
        "thumbnails": [
            {"id": "0", "url": "https://fake.test/t0.jpg", "width": 120, "height": 90},
            {"id": "1", "url": "https://fake.test/t1.jpg", "width": 1280, "height": 720},
        ],
        "webpage_url": f"https://fake.test/watch?v={video_id}",
        "original_url": f"https://fake.test/watch?v={video_id}",
        "extractor": "fake",
        "extractor_key": "Fake",
        "is_live": False,
        "was_live": False,
        "live_status": "not_live",
        "availability": "public",
        "license": "Standard YouTube licence",
        "age_limit": 0,
        "view_count": 123456,
        "like_count": 7890,
        "categories": ["Music"],
        "tags": ["fake", "test"],
        "chapters": [
            {"title": "Intro", "start_time": 0.0, "end_time": 30.0},
            {"title": "Body", "start_time": 30.0, "end_time": 213.5},
        ],
        "formats": [
            {
                "format_id": "140",
                "format_note": "medium",
                "ext": "m4a",
                "protocol": "https",
                "resolution": "audio only",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
                "abr": 129.5,
                "asr": 44100,
                "audio_channels": 2,
                "filesize": 3_456_789,
                "tbr": 129.5,
                "language": "en",
            },
            {
                "format_id": "137",
                "format_note": "1080p",
                "ext": "mp4",
                "protocol": "https",
                "resolution": "1920x1080",
                "width": 1920,
                "height": 1080,
                "fps": 30,
                "vcodec": "avc1.640028",
                "acodec": "none",
                "filesize": 45_678_901,
                "tbr": 4500.0,
                "dynamic_range": "SDR",
            },
            {
                "format_id": "18",
                "format_note": "360p",
                "ext": "mp4",
                "protocol": "https",
                "resolution": "640x360",
                "width": 640,
                "height": 360,
                "fps": 30,
                "vcodec": "avc1.42001E",
                "acodec": "mp4a.40.2",
                "filesize_approx": 12_345_678,
                "tbr": 700.0,
            },
        ],
        "subtitles": {
            "en": [{"ext": "vtt", "url": "https://fake.test/en.vtt", "name": "English"}],
            "es": [{"ext": "vtt", "url": "https://fake.test/es.vtt", "name": "Spanish"}],
        },
        "automatic_captions": {
            "en": [{"ext": "vtt", "url": "https://fake.test/auto-en.vtt", "name": "English (auto)"}]
        },
    }


def _render_template(template: str, fields: Mapping[str, Any]) -> str:
    return _TEMPLATE_FIELD.sub(lambda m: str(fields.get(m.group(1), m.group(1))), template)


def _sanitise(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", name)


class _Scenario:
    """One canned behaviour, chosen by URL path."""

    def __init__(
        self,
        *,
        error: str | None = None,
        streams: tuple[str, ...] = ("137", "140"),
        ticks: int = 4,
        tick_delay: float = 0.0,
        playlist: int = 0,
        total_bytes: int | None = 5_000_000,
    ) -> None:
        self.error = error
        self.streams = streams
        self.ticks = ticks
        self.tick_delay = tick_delay
        self.playlist = playlist
        self.total_bytes = total_bytes


SCENARIOS: dict[str, _Scenario] = {
    # The default: a video+audio merge, so progress restarts between streams.
    "/video": _Scenario(),
    "/audio": _Scenario(streams=("140",)),
    "/single": _Scenario(streams=("18",)),
    "/unknown-size": _Scenario(streams=("18",), total_bytes=None),
    "/slow": _Scenario(streams=("137",), ticks=400, tick_delay=0.01),
    "/playlist": _Scenario(playlist=3, streams=("18",)),
    "/unavailable": _Scenario(error="ERROR: Video unavailable. This video is private"),
    "/format": _Scenario(error="ERROR: Requested format is not available"),
    "/potoken": _Scenario(
        error="ERROR: unable to download video data: HTTP Error 403: Forbidden. "
        "The following content is not available on this app: a PO Token is required"
    ),
    "/network": _Scenario(error="ERROR: Unable to download webpage: The read operation timed out"),
    "/unsupported": _Scenario(error="ERROR: Unsupported URL: https://fake.test/unsupported"),
    "/nojs": _Scenario(error="ERROR: No supported JavaScript runtime could be found"),
    "/disk": _Scenario(error="ERROR: unable to open for writing: No space left on device"),
}

_DEFAULT_SCENARIO = SCENARIOS["/video"]


class FakeYoutubeDL:
    """Stands in for ``yt_dlp.YoutubeDL``.

    Every instance records the options it was built with, so a test can assert
    on the format selector, the postprocessor list, ``js_runtimes`` and so on.
    """

    #: Every instance built since the last :func:`install`.
    instances: list["FakeYoutubeDL"] = []
    _lock = threading.Lock()

    def __init__(self, opts: dict[str, Any]) -> None:
        self.opts = opts
        self.downloaded: list[Path] = []
        with FakeYoutubeDL._lock:
            FakeYoutubeDL.instances.append(self)

    def __enter__(self) -> "FakeYoutubeDL":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    # --- helpers -----------------------------------------------------------

    @property
    def progress_hooks(self) -> list[Callable[[dict[str, Any]], None]]:
        return list(self.opts.get("progress_hooks") or [])

    @property
    def postprocessor_hooks(self) -> list[Callable[[dict[str, Any]], None]]:
        return list(self.opts.get("postprocessor_hooks") or [])

    def _outtmpl(self) -> str:
        outtmpl = self.opts.get("outtmpl")
        if isinstance(outtmpl, Mapping):
            return str(outtmpl.get("default"))
        return str(outtmpl)

    def _final_ext(self, default: str) -> str:
        for processor in self.opts.get("postprocessors") or []:
            if processor.get("key") == "FFmpegExtractAudio":
                codec = processor.get("preferredcodec")
                if codec and codec != "best":
                    return str(codec)
        merge = self.opts.get("merge_output_format")
        return str(merge) if merge else default

    def _target(self, info: Mapping[str, Any], ext: str, index: int | None = None) -> Path:
        fields = {
            "title": _sanitise(str(info.get("title"))),
            "id": info.get("id"),
            "ext": ext,
            "playlist_index": index if index is not None else 1,
        }
        return Path(_render_template(self._outtmpl(), fields))

    # --- the API the service uses -----------------------------------------

    def extract_info(self, url: str, download: bool = False) -> dict[str, Any] | None:
        scenario = SCENARIOS.get(urlparse(url).path, _DEFAULT_SCENARIO)

        if scenario.error:
            raise DownloadError(scenario.error)

        if scenario.playlist:
            entries = [
                make_info(f"entry{i}", f"Entry {i}") for i in range(1, scenario.playlist + 1)
            ]
            playlist_info: dict[str, Any] = {
                "_type": "playlist",
                "id": "PL_fake",
                "title": "Fake Playlist",
                "webpage_url": url,
                "extractor": "fake",
                "playlist_count": len(entries),
                "entries": entries,
            }
            if download:
                for index, entry in enumerate(entries, start=1):
                    self._run_download(entry, scenario, index=index)
            return playlist_info

        info = make_info()
        info["webpage_url"] = url
        if not download:
            return info

        self._run_download(info, scenario)
        return info

    def _run_download(
        self, info: dict[str, Any], scenario: _Scenario, index: int | None = None
    ) -> None:
        hooks = self.progress_hooks
        base_ext = "m4a" if scenario.streams == ("140",) else "mp4"
        final_ext = self._final_ext(base_ext)
        target = self._target(info, final_ext, index)
        target.parent.mkdir(parents=True, exist_ok=True)

        started = time.monotonic()
        for stream_index, format_id in enumerate(scenario.streams):
            source = next(
                (f for f in info["formats"] if f["format_id"] == format_id), info["formats"][0]
            )
            stream_ext = source.get("ext", "mp4")
            part = target.with_name(f"{target.stem}.f{format_id}.{stream_ext}")
            # Use the format's own declared size, so a merge produces a large
            # video stream and a small audio one exactly as the real thing does.
            # A scenario with total_bytes=None keeps its unknown size.
            total = scenario.total_bytes
            if total is not None:
                total = source.get("filesize") or source.get("filesize_approx") or total

            for tick in range(1, scenario.ticks + 1):
                if scenario.tick_delay:
                    time.sleep(scenario.tick_delay)
                downloaded = (
                    int((total or 1_000_000) * tick / scenario.ticks)
                    if total
                    else tick * 250_000
                )
                status: dict[str, Any] = {
                    "status": "downloading",
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "total_bytes_estimate": None if total else 4_000_000,
                    "speed": 1_500_000.0,
                    "eta": max(0, scenario.ticks - tick),
                    "elapsed": time.monotonic() - started,
                    "fragment_index": tick,
                    "fragment_count": scenario.ticks,
                    "filename": str(part),
                    "info_dict": {
                        "format_id": format_id,
                        "ext": stream_ext,
                        "vcodec": source.get("vcodec"),
                        "acodec": source.get("acodec"),
                    },
                }
                for hook in hooks:
                    hook(status)

            payload = f"stream {format_id} of {info['id']}".encode() * 64
            if len(scenario.streams) == 1:
                target.write_bytes(payload)
                written = target
            else:
                part.write_bytes(payload)
                written = part
            self.downloaded.append(written)

            for hook in hooks:
                hook(
                    {
                        "status": "finished",
                        "downloaded_bytes": len(payload),
                        "total_bytes": len(payload),
                        "elapsed": time.monotonic() - started,
                        "filename": str(written),
                        "info_dict": {
                        "format_id": format_id,
                        "ext": stream_ext,
                        "vcodec": source.get("vcodec"),
                        "acodec": source.get("acodec"),
                    },
                    }
                )

        # Merge, then run whatever postprocessors were configured.
        if len(scenario.streams) > 1:
            merged = b"".join(path.read_bytes() for path in self.downloaded if path.exists())
            target.write_bytes(merged)
            for path in list(self.downloaded):
                if path != target and path.exists():
                    path.unlink()
            self.downloaded = [target]

        info["filepath"] = str(target)
        info["requested_downloads"] = [{"filepath": str(target), "ext": final_ext}]

        for processor in self.opts.get("postprocessors") or []:
            for phase in ("started", "finished"):
                for hook in self.postprocessor_hooks:
                    hook(
                        {
                            "status": phase,
                            "postprocessor": processor.get("key"),
                            "info_dict": dict(info),
                        }
                    )

        if self.opts.get("writethumbnail"):
            target.with_suffix(".webp").write_bytes(b"fake-thumbnail")
        for language in self.opts.get("subtitleslangs") or []:
            if language != "all":
                target.with_suffix(f".{language}.vtt").write_text(
                    "WEBVTT\n\n00:00.000 --> 00:02.000\nhello\n", encoding="utf-8"
                )


def install(monkeypatch: Any) -> type[FakeYoutubeDL]:
    """Point the service's one yt-dlp seam at the fake."""
    from inferno_service import ytdlp

    FakeYoutubeDL.instances = []
    monkeypatch.setattr(ytdlp, "build_ydl", FakeYoutubeDL)
    return FakeYoutubeDL
