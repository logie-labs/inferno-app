"""Request intent -> yt-dlp options. The single source of truth (SPEC §7).

The rule that matters: **clients send intent, the server resolves it.** A client
never computes a format id and hands it over alongside a contradictory flag. The
previous implementation allowed exactly that and produced a merged video+audio
selector for an audio-only job, which then failed on a missing merge step.

So the three resolution rules live in one function, :func:`resolve`:

1. ``mode: "audio"`` produces an audio-only selector. ``quality`` and
   ``container`` are ignored, and a merged ``a+b`` selector is never produced.
2. ``mode: "video"`` produces a height-capped selector from ``quality``.
3. An explicit ``format_id`` is an escape hatch and wins **only if it is
   compatible with ``mode``**. A merged ``a+b`` id combined with ``mode:
   "audio"`` is a ``400 format_mode_conflict``, rejected here at the boundary
   rather than failing deep inside yt-dlp with a confusing message.

This module also does the ffmpeg preflight from SPEC §10: if a job asks for mp3
output and no ffmpeg resolved, it fails immediately rather than after 200 MB.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .binaries import BinaryResolver
from .config import Settings
from .errors import ErrorCode, ServiceError
from .schemas import DownloadRequest

__all__ = ["Resolution", "resolve", "QUALITY_HEIGHTS", "DEFAULT_OUTPUT_TEMPLATE"]

#: ``quality`` values mapped to a height cap. ``None`` means "no cap".
QUALITY_HEIGHTS: dict[str, int | None] = {
    "best": None,
    "4320p": 4320,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
    "240p": 240,
    "144p": 144,
    "worst": None,
}

DEFAULT_OUTPUT_TEMPLATE = "%(title)s [%(id)s].%(ext)s"
DEFAULT_PLAYLIST_TEMPLATE = "%(playlist_index)03d - %(title)s [%(id)s].%(ext)s"

#: Audio-only selector. Deliberately free of any '+' so no merge is implied.
AUDIO_SELECTOR = "bestaudio/best"

#: How to ask for audio that is *already* in the requested form, per format.
#: Only the ones a site actually serves natively appear here; everything else
#: genuinely has to be encoded.
_NATIVE_AUDIO_FILTER = {
    "m4a": "[ext=m4a]",
    "opus": "[acodec=opus]",
}


def _audio_selector(audio_format: str | None) -> str:
    """Prefer an audio stream that is already in the requested form.

    Extracting audio is not about YouTube withholding it - YouTube serves
    audio-only streams directly, and ``bestaudio`` downloads one. The catch is
    *which* one: on YouTube the best is opus in webm (format 251), so asking
    for m4a on top of it makes ``FFmpegExtractAudio`` transcode opus -> AAC.
    That is slow, and lossy a second time over a stream that was already lossy.
    Format 140 is AAC in m4a to begin with, so naming the container first turns
    the postprocessor into "Not converting audio; file is already in target
    format" - no transcode, no quality lost, no ffmpeg pass to go wrong.

    Ordered, not restrictive: a site that has no such stream falls straight
    through to ``bestaudio/best`` and is converted exactly as before.
    """
    native = _NATIVE_AUDIO_FILTER.get((audio_format or "").lower())
    if not native:
        return AUDIO_SELECTOR

    return f"bestaudio{native}/{AUDIO_SELECTOR}"


@dataclass
class Resolution:
    """What the server decided, and the yt-dlp options that express it."""

    #: The resolved options echoed back on the job object (SPEC §6).
    summary: dict[str, Any]
    #: The dict handed to ``YoutubeDL``.
    ydl_opts: dict[str, Any]
    #: True when the chosen selector can produce a video+audio merge.
    merging: bool = False
    #: Why ffmpeg is needed, empty when it is not.
    ffmpeg_reasons: list[str] = field(default_factory=list)

    @property
    def format_selector(self) -> str:
        return str(self.ydl_opts.get("format", ""))

    @property
    def requires_ffmpeg(self) -> bool:
        return bool(self.ffmpeg_reasons)


def _video_selector(quality: str) -> str:
    if quality == "best":
        return "bestvideo*+bestaudio/best"
    if quality == "worst":
        return "worstvideo*+worstaudio/worst"
    height = QUALITY_HEIGHTS[quality]
    return f"bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"


_FRIENDLY_FIELD = re.compile(r"\{(\w+)\}")


def translate_template(template: str) -> str:
    """Accept friendly ``{title}.{ext}`` placeholders as well as yt-dlp's syntax.

    A settings panel naturally offers ``{title}.{ext}``. Passed through
    untouched, yt-dlp treats the braces as literal characters and writes a file
    genuinely named ``{title}.{ext}`` — a silent wrong-output bug rather than an
    error. A template that already uses ``%(...)s`` is left exactly as written.
    """
    if "%(" in template:
        return template
    return _FRIENDLY_FIELD.sub(lambda match: f"%({match.group(1)})s", template)


def _parse_cookies_from_browser(value: str) -> tuple[str, ...]:
    """yt-dlp wants a tuple of (browser, profile, keyring, container)."""
    parts = [part.strip() or None for part in value.split(":")][:4]
    while parts and parts[-1] is None:
        parts.pop()
    if not parts or parts[0] is None:
        raise ServiceError(
            ErrorCode.INVALID_REQUEST,
            f"COOKIES_FROM_BROWSER={value!r} does not name a browser",
        )
    return tuple(parts)  # type: ignore[return-value]


def resolve(
    request: DownloadRequest,
    settings: Settings,
    binaries: BinaryResolver,
    job_dir: Path,
) -> Resolution:
    """Turn one :class:`DownloadRequest` into a :class:`Resolution`.

    Raises :class:`ServiceError` with ``format_mode_conflict`` or
    ``ffmpeg_missing`` rather than letting either surface later.
    """
    audio_mode = request.mode == "audio"
    ignored: list[str] = []
    ffmpeg_reasons: list[str] = []

    # --- rule 3 first: does the escape hatch contradict the mode? ----------
    explicit = request.format_id
    if explicit and audio_mode and "+" in explicit:
        raise ServiceError(
            ErrorCode.FORMAT_MODE_CONFLICT,
            (
                f"format_id {explicit!r} merges a video and an audio stream, which "
                'contradicts mode="audio". Send an audio-only format id, or drop '
                "format_id and let the server choose."
            ),
            {"format_id": explicit, "mode": request.mode},
        )

    # --- rules 1 and 2: the selector --------------------------------------
    if explicit:
        selector = explicit
        merging = "+" in explicit
    elif audio_mode:
        selector = _audio_selector(request.audio_format)
        merging = False
    else:
        selector = _video_selector(request.quality)
        merging = "+" in selector

    if audio_mode:
        # SPEC §7 rule 1: quality and container are ignored for audio.
        if request.quality != "best":
            ignored.append("quality")
        if request.container is not None:
            ignored.append("container")

    # A belt-and-braces check on the invariant the previous implementation broke.
    if audio_mode and "+" in selector:  # pragma: no cover - unreachable by construction
        raise ServiceError(
            ErrorCode.FORMAT_MODE_CONFLICT,
            "Refusing to run an audio job with a merged selector.",
            {"format": selector, "mode": request.mode},
        )

    # --- postprocessors and what they imply about ffmpeg ------------------
    postprocessors: list[dict[str, Any]] = []

    if audio_mode and request.audio_format:
        postprocessors.append(
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": request.audio_format,
                "preferredquality": str(request.audio_quality),
                "nopostoverwrites": False,
            }
        )
        ffmpeg_reasons.append(f"audio_format={request.audio_format}")

    # embed_subtitles with nothing selected obviously means "all of them".
    subtitle_langs = list(request.subtitles)
    want_subtitles = bool(subtitle_langs)
    want_auto = request.auto_subtitles
    if request.embed_subtitles and not want_subtitles and not want_auto:
        subtitle_langs = ["all"]
        want_subtitles = True

    if request.embed_subtitles and (want_subtitles or want_auto):
        postprocessors.append(
            {
                "key": "FFmpegEmbedSubtitle",
                "already_have_subtitle": bool(request.subtitles),
            }
        )
        ffmpeg_reasons.append("embed_subtitles")

    if request.embed_metadata:
        postprocessors.append(
            {"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True}
        )
        ffmpeg_reasons.append("embed_metadata")

    if request.embed_thumbnail:
        postprocessors.append(
            {"key": "EmbedThumbnail", "already_have_thumbnail": request.write_thumbnail}
        )
        ffmpeg_reasons.append("embed_thumbnail")

    merge_output_format = None
    if not audio_mode and request.container:
        merge_output_format = request.container
        if merging:
            ffmpeg_reasons.append(f"container={request.container}")

    if merging:
        ffmpeg_reasons.append("merge of separate video and audio streams")

    # --- SPEC §10 preflight -----------------------------------------------
    if ffmpeg_reasons and not binaries.ffmpeg.available:
        raise ServiceError(
            ErrorCode.FFMPEG_MISSING,
            "This job needs ffmpeg but none resolved. Bundle it in vendor/ffmpeg or set FFMPEG_DIR.",
            {
                "reasons": ffmpeg_reasons,
                "ffmpeg": binaries.ffmpeg.to_dict(),
                "ffprobe": binaries.ffprobe.to_dict(),
            },
        )

    # --- assemble the yt-dlp options --------------------------------------
    template = translate_template(
        request.output_template
        or (DEFAULT_PLAYLIST_TEMPLATE if request.playlist else DEFAULT_OUTPUT_TEMPLATE)
    )
    outtmpl = str(job_dir / template)

    ydl_opts: dict[str, Any] = {
        "format": selector,
        "outtmpl": {"default": outtmpl},
        "paths": {"home": str(job_dir)},
        "noplaylist": not request.playlist,
        "playlist_items": None,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "consoletitle": False,
        "color": {"stdout": "no_color", "stderr": "no_color"},
        "retries": settings.retries,
        "fragment_retries": settings.retries,
        "file_access_retries": 3,
        "concurrent_fragment_downloads": request.concurrent_fragments,
        "overwrites": True,
        "continuedl": True,
        "ignoreerrors": False,
        "trim_file_name": 180,
        "windowsfilenames": os.name == "nt",
        "postprocessors": postprocessors,
    }

    if merge_output_format:
        ydl_opts["merge_output_format"] = merge_output_format

    if want_subtitles:
        ydl_opts["writesubtitles"] = True
        ydl_opts["subtitleslangs"] = subtitle_langs
    if want_auto:
        ydl_opts["writeautomaticsub"] = True
        ydl_opts.setdefault("subtitleslangs", subtitle_langs or ["en"])

    if request.write_thumbnail or request.embed_thumbnail:
        ydl_opts["writethumbnail"] = True

    if request.rate_limit:
        ydl_opts["ratelimit"] = request.rate_limit

    if settings.proxy:
        ydl_opts["proxy"] = settings.proxy

    if settings.http_chunk_size > 0:
        # SPEC §8: forces ranged GETs. Set to 0 to disable.
        ydl_opts["http_chunk_size"] = settings.http_chunk_size

    ffmpeg_location = binaries.ffmpeg_dir
    if ffmpeg_location:
        # Point yt-dlp at the directory, so it finds ffprobe beside ffmpeg.
        ydl_opts["ffmpeg_location"] = ffmpeg_location

    js_runtimes = binaries.js_runtimes_option()
    if js_runtimes:
        # SPEC §8: a dict of {runtime: {config}}, never the CLI's RUNTIME:PATH
        # string and never a None value.
        ydl_opts["js_runtimes"] = js_runtimes

    cookies_summary: str | None = None
    if settings.cookie_file:
        ydl_opts["cookiefile"] = settings.cookie_file
        cookies_summary = f"file:{settings.cookie_file}"
    elif settings.cookies_from_browser:
        ydl_opts["cookiesfrombrowser"] = _parse_cookies_from_browser(settings.cookies_from_browser)
        cookies_summary = f"browser:{settings.cookies_from_browser}"

    summary: dict[str, Any] = {
        "mode": request.mode,
        "format": selector,
        "format_id": explicit,
        "quality": None if audio_mode else request.quality,
        "container": None if audio_mode else request.container,
        "merge_output_format": merge_output_format,
        "audio_format": request.audio_format if audio_mode else None,
        "audio_quality": request.audio_quality if audio_mode and request.audio_format else None,
        "playlist": request.playlist,
        "subtitles": subtitle_langs,
        "auto_subtitles": want_auto,
        "embed_subtitles": request.embed_subtitles,
        "write_thumbnail": request.write_thumbnail,
        "embed_thumbnail": request.embed_thumbnail,
        "embed_metadata": request.embed_metadata,
        "output_template": template,
        "concurrent_fragments": request.concurrent_fragments,
        "rate_limit": request.rate_limit,
        "http_chunk_size": settings.http_chunk_size or None,
        "postprocessors": [pp["key"] for pp in postprocessors],
        "merging": merging,
        "requires_ffmpeg": bool(ffmpeg_reasons),
        "ffmpeg_reasons": ffmpeg_reasons,
        "ffmpeg_location": ffmpeg_location,
        "js_runtime": (list(js_runtimes) or [None])[0] if js_runtimes else None,
        "cookies": cookies_summary,
        "ignored": ignored,
        "requested": request.model_dump(mode="json"),
    }

    return Resolution(
        summary=summary, ydl_opts=ydl_opts, merging=merging, ffmpeg_reasons=ffmpeg_reasons
    )
