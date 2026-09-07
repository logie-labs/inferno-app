"""Metadata fetch and normalisation, with a short-TTL cache (SPEC §3, §4).

Normalisation follows the raw-values principle (SPEC §1): bytes are integers,
timestamps are epoch seconds or ISO-8601 dates, codecs are as reported upstream.
Nothing here formats anything for display — that is the client's job.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable, Hashable, Mapping

from .binaries import BinaryResolver
from .config import Settings
from .errors import ErrorCode, ServiceError, classify_exception
from . import ytdlp

__all__ = [
    "InfoCache",
    "Extractor",
    "normalise_format",
    "normalise_video",
    "normalise_playlist",
    "normalise_subtitles",
    "validate_url",
]


def validate_url(url: str) -> str:
    """Cheap upfront check so obvious rubbish never reaches an extractor."""
    candidate = (url or "").strip()
    if not candidate:
        raise ServiceError(ErrorCode.INVALID_URL, "A url is required.")
    lowered = candidate.lower()
    if not (lowered.startswith("http://") or lowered.startswith("https://")):
        raise ServiceError(
            ErrorCode.INVALID_URL,
            "url must be an http or https URL.",
            {"url": candidate},
        )
    remainder = candidate.split("://", 1)[1]
    if not remainder or remainder.startswith("/"):
        raise ServiceError(ErrorCode.INVALID_URL, "url has no host.", {"url": candidate})
    return candidate


class InfoCache:
    """A tiny TTL cache. ``ttl <= 0`` disables it entirely (SPEC §9)."""

    def __init__(self, ttl: int, clock: Callable[[], float] | None = None) -> None:
        self.ttl = ttl
        self._clock = clock or time.monotonic
        self._entries: dict[Hashable, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.ttl > 0

    def get(self, key: Hashable) -> Any | None:
        if not self.enabled:
            return None
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if self._clock() >= expires_at:
                self._entries.pop(key, None)
                return None
            return value

    def set(self, key: Hashable, value: Any) -> None:
        if not self.enabled:
            return
        with self._lock:
            self._entries[key] = (self._clock() + self.ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


# --- normalisation ----------------------------------------------------------


def _as_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _iso_date(compact: Any) -> str | None:
    """yt-dlp reports ``upload_date`` as ``YYYYMMDD``. Give clients ISO-8601."""
    text = str(compact or "")
    if len(text) != 8 or not text.isdigit():
        return None
    return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"


def normalise_format(raw: Mapping[str, Any]) -> dict[str, Any]:
    """One entry of the format table, in raw units."""
    vcodec = raw.get("vcodec")
    acodec = raw.get("acodec")
    has_video = bool(vcodec) and vcodec != "none"
    has_audio = bool(acodec) and acodec != "none"
    return {
        "format_id": raw.get("format_id"),
        "format_note": raw.get("format_note"),
        "ext": raw.get("ext"),
        "protocol": raw.get("protocol"),
        "container": raw.get("container"),
        "resolution": raw.get("resolution"),
        "width": _as_int(raw.get("width")),
        "height": _as_int(raw.get("height")),
        "fps": _as_float(raw.get("fps")),
        "dynamic_range": raw.get("dynamic_range"),
        "vcodec": vcodec,
        "acodec": acodec,
        "has_video": has_video,
        "has_audio": has_audio,
        "filesize": _as_int(raw.get("filesize")),
        "filesize_approx": _as_int(raw.get("filesize_approx")),
        "tbr": _as_float(raw.get("tbr")),
        "vbr": _as_float(raw.get("vbr")),
        "abr": _as_float(raw.get("abr")),
        "asr": _as_int(raw.get("asr")),
        "audio_channels": _as_int(raw.get("audio_channels")),
        "language": raw.get("language"),
        "quality": _as_float(raw.get("quality")),
        "preference": _as_int(raw.get("preference")),
    }


def normalise_subtitles(raw: Mapping[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
    """Caption track listing. Fetches nothing; this is metadata only."""
    result: dict[str, list[dict[str, Any]]] = {}
    for language, tracks in (raw or {}).items():
        entries: list[dict[str, Any]] = []
        for track in tracks or []:
            if not isinstance(track, Mapping):
                continue
            entries.append(
                {
                    "ext": track.get("ext"),
                    "url": track.get("url"),
                    "name": track.get("name"),
                    "protocol": track.get("protocol"),
                }
            )
        result[str(language)] = entries
    return result


def _normalise_chapters(raw: Any) -> list[dict[str, Any]]:
    chapters: list[dict[str, Any]] = []
    for chapter in raw or []:
        if not isinstance(chapter, Mapping):
            continue
        chapters.append(
            {
                "title": chapter.get("title"),
                "start_time": _as_float(chapter.get("start_time")),
                "end_time": _as_float(chapter.get("end_time")),
            }
        )
    return chapters


def _normalise_thumbnails(raw: Any) -> list[dict[str, Any]]:
    thumbnails: list[dict[str, Any]] = []
    for thumbnail in raw or []:
        if not isinstance(thumbnail, Mapping):
            continue
        thumbnails.append(
            {
                "id": thumbnail.get("id"),
                "url": thumbnail.get("url"),
                "width": _as_int(thumbnail.get("width")),
                "height": _as_int(thumbnail.get("height")),
                "preference": _as_int(thumbnail.get("preference")),
            }
        )
    return thumbnails


def normalise_video(raw: Mapping[str, Any]) -> dict[str, Any]:
    """The normalised video object used by ``/info`` and by job objects."""
    formats = [normalise_format(f) for f in raw.get("formats") or [] if isinstance(f, Mapping)]
    return {
        "id": raw.get("id"),
        "title": raw.get("title"),
        "description": raw.get("description"),
        "uploader": raw.get("uploader"),
        "uploader_id": raw.get("uploader_id"),
        "uploader_url": raw.get("uploader_url"),
        "channel": raw.get("channel"),
        "channel_id": raw.get("channel_id"),
        "channel_url": raw.get("channel_url"),
        "channel_follower_count": _as_int(raw.get("channel_follower_count")),
        "duration": _as_float(raw.get("duration")),
        "upload_date": _iso_date(raw.get("upload_date")),
        "timestamp": _as_int(raw.get("timestamp")),
        "release_timestamp": _as_int(raw.get("release_timestamp")),
        "thumbnail": raw.get("thumbnail"),
        "thumbnails": _normalise_thumbnails(raw.get("thumbnails")),
        "webpage_url": raw.get("webpage_url"),
        "original_url": raw.get("original_url"),
        "extractor": raw.get("extractor"),
        "extractor_key": raw.get("extractor_key"),
        "is_live": bool(raw.get("is_live")),
        "was_live": bool(raw.get("was_live")),
        "live_status": raw.get("live_status"),
        "availability": raw.get("availability"),
        "license": raw.get("license"),
        "age_limit": _as_int(raw.get("age_limit")),
        "view_count": _as_int(raw.get("view_count")),
        "like_count": _as_int(raw.get("like_count")),
        "comment_count": _as_int(raw.get("comment_count")),
        "categories": list(raw.get("categories") or []),
        "tags": list(raw.get("tags") or []),
        "chapters": _normalise_chapters(raw.get("chapters")),
        "formats": formats,
        "subtitles": normalise_subtitles(raw.get("subtitles")),
        "automatic_captions": normalise_subtitles(raw.get("automatic_captions")),
    }


def normalise_playlist(raw: Mapping[str, Any]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for entry in raw.get("entries") or []:
        if not isinstance(entry, Mapping):
            continue
        entries.append(
            {
                "id": entry.get("id"),
                "title": entry.get("title"),
                "url": entry.get("url") or entry.get("webpage_url"),
                "duration": _as_float(entry.get("duration")),
                "uploader": entry.get("uploader"),
                "thumbnail": entry.get("thumbnail"),
            }
        )
    return {
        "id": raw.get("id"),
        "title": raw.get("title"),
        "uploader": raw.get("uploader") or raw.get("channel"),
        "webpage_url": raw.get("webpage_url"),
        "extractor": raw.get("extractor"),
        "count": _as_int(raw.get("playlist_count")) or len(entries),
        "entries": entries,
    }


def is_playlist(raw: Mapping[str, Any]) -> bool:
    return raw.get("_type") in {"playlist", "multi_video"} or "entries" in raw


# --- extraction -------------------------------------------------------------


class Extractor:
    """Fetches metadata through yt-dlp and normalises it."""

    def __init__(
        self,
        settings: Settings,
        binaries: BinaryResolver,
        cache: InfoCache | None = None,
    ) -> None:
        self._settings = settings
        self._binaries = binaries
        self.cache = cache if cache is not None else InfoCache(settings.info_cache_ttl)

    def apply_settings(self, settings: Settings) -> None:
        """Adopt a new settings snapshot without dropping the warm cache."""
        self._settings = settings
        self.cache.ttl = settings.info_cache_ttl
        if not self.cache.enabled:
            self.cache.clear()

    def base_opts(self) -> dict[str, Any]:
        """Options shared by every metadata-only extraction."""
        opts: dict[str, Any] = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "skip_download": True,
            "color": {"stdout": "no_color", "stderr": "no_color"},
            "retries": self._settings.retries,
            "extract_flat": False,
        }
        if self._settings.proxy:
            opts["proxy"] = self._settings.proxy
        ffmpeg_location = self._binaries.ffmpeg_dir
        if ffmpeg_location:
            opts["ffmpeg_location"] = ffmpeg_location
        js_runtimes = self._binaries.js_runtimes_option()
        if js_runtimes:
            opts["js_runtimes"] = js_runtimes
        if self._settings.cookie_file:
            opts["cookiefile"] = self._settings.cookie_file
        elif self._settings.cookies_from_browser:
            from .options import _parse_cookies_from_browser

            opts["cookiesfrombrowser"] = _parse_cookies_from_browser(
                self._settings.cookies_from_browser
            )
        return opts

    def fetch_raw(self, url: str, *, playlist: bool = False) -> dict[str, Any]:
        """Blocking extraction. Runs on a worker thread in async callers."""
        opts = self.base_opts()
        opts["noplaylist"] = not playlist
        if playlist:
            # Flat extraction keeps a 200-entry playlist from taking minutes.
            opts["extract_flat"] = "in_playlist"
        try:
            with ytdlp.build_ydl(opts) as ydl:
                raw = ydl.extract_info(url, download=False)
        except ServiceError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified into a stable code
            raise classify_exception(exc, context="extraction") from exc
        if not raw:
            raise ServiceError(
                ErrorCode.VIDEO_UNAVAILABLE,
                "The extractor returned no metadata for this URL.",
                {"url": url},
            )
        return dict(raw)

    def normalise(self, raw: Mapping[str, Any], url: str) -> dict[str, Any]:
        if is_playlist(raw):
            return {"url": url, "video": None, "playlist": normalise_playlist(raw)}
        return {"url": url, "video": normalise_video(raw), "playlist": None}

    async def info(
        self, url: str, *, playlist: bool = False, refresh: bool = False
    ) -> dict[str, Any]:
        """Normalised metadata, served from the cache when it is warm."""
        url = validate_url(url)
        key = (url, playlist)
        if not refresh:
            cached = self.cache.get(key)
            if cached is not None:
                return {**cached, "cached": True}

        raw = await asyncio.to_thread(self.fetch_raw, url, playlist=playlist)
        payload = self.normalise(raw, url)
        self.cache.set(key, payload)
        return {**payload, "cached": False}

    async def raw_info(
        self, url: str, *, playlist: bool = False, refresh: bool = False
    ) -> dict[str, Any]:
        """Like :meth:`info` but returns the normalised payload without the flag."""
        payload = await self.info(url, playlist=playlist, refresh=refresh)
        payload.pop("cached", None)
        return payload
