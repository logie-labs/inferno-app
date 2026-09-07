"""SPEC §7 — the one rule that matters: clients send intent, the server resolves.

The bug this module exists to prevent, quoted from the spec: the previous
implementation let the client compute a format id and send it alongside
``audio_only: true``, which produced a merged video+audio selector for an
audio-only job, which then failed on a missing merge step.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from inferno_service.binaries import BinaryResolver
from inferno_service.config import Settings
from inferno_service.errors import ErrorCode, ServiceError
from inferno_service.options import AUDIO_SELECTOR, resolve
from inferno_service.schemas import DownloadRequest


def req(**overrides: object) -> DownloadRequest:
    payload: dict[str, object] = {"url": "https://fake.test/video"}
    payload.update(overrides)
    return DownloadRequest(**payload)  # type: ignore[arg-type]


@pytest.fixture
def job_dir(tmp_path: Path) -> Path:
    return tmp_path / "job"


# --- rule 1: audio ----------------------------------------------------------


def test_audio_mode_produces_an_audio_only_selector(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(mode="audio"), settings, binaries, job_dir)
    assert resolution.format_selector == AUDIO_SELECTOR
    assert "+" not in resolution.format_selector


def test_audio_mode_ignores_quality_and_container(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(mode="audio", quality="1080p", container="mp4"), settings, binaries, job_dir
    )
    assert resolution.format_selector == AUDIO_SELECTOR
    assert "merge_output_format" not in resolution.ydl_opts
    assert resolution.summary["quality"] is None
    assert resolution.summary["container"] is None
    assert sorted(resolution.summary["ignored"]) == ["container", "quality"]


def test_audio_mode_adds_the_extract_audio_postprocessor(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(mode="audio", audio_format="mp3", audio_quality=192), settings, binaries, job_dir
    )
    processors = resolution.ydl_opts["postprocessors"]
    extract = next(p for p in processors if p["key"] == "FFmpegExtractAudio")
    assert extract["preferredcodec"] == "mp3"
    assert extract["preferredquality"] == "192"
    assert resolution.summary["audio_format"] == "mp3"
    assert resolution.summary["audio_quality"] == 192


def test_m4a_asks_for_a_stream_that_is_already_m4a(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    """Avoid a transcode nobody asked for.

    `bestaudio` on YouTube is opus in webm, so requesting m4a on top of it
    re-encodes opus -> AAC: slow, and lossy over an already-lossy stream.
    Format 140 is AAC in m4a to begin with.
    """
    resolution = resolve(
        req(mode="audio", audio_format="m4a"), settings, binaries, job_dir
    )
    assert resolution.format_selector == f"bestaudio[ext=m4a]/{AUDIO_SELECTOR}"
    # Still audio-only: a merge here would contradict the mode.
    assert "+" not in resolution.format_selector


def test_a_format_no_site_serves_natively_is_left_to_the_encoder(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    # Nothing serves mp3, so there is nothing to prefer and the selector is
    # unchanged - the postprocessor does the work, as it always did.
    resolution = resolve(
        req(mode="audio", audio_format="mp3"), settings, binaries, job_dir
    )
    assert resolution.format_selector == AUDIO_SELECTOR


def test_audio_without_a_codec_needs_no_re_encode(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(mode="audio", embed_thumbnail=False, embed_metadata=False),
        settings,
        binaries,
        job_dir,
    )
    assert [p["key"] for p in resolution.ydl_opts["postprocessors"]] == []
    assert resolution.requires_ffmpeg is False


# --- rule 2: video ----------------------------------------------------------


@pytest.mark.parametrize(
    ("quality", "height"),
    [("1080p", 1080), ("720p", 720), ("480p", 480), ("144p", 144), ("2160p", 2160)],
)
def test_video_mode_caps_height_from_quality(
    settings: Settings, binaries: BinaryResolver, job_dir: Path, quality: str, height: int
) -> None:
    resolution = resolve(req(mode="video", quality=quality), settings, binaries, job_dir)
    assert f"height<={height}" in resolution.format_selector


def test_video_best_and_worst_have_no_height_cap(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    best = resolve(req(quality="best"), settings, binaries, job_dir)
    worst = resolve(req(quality="worst"), settings, binaries, job_dir)
    assert best.format_selector == "bestvideo*+bestaudio/best"
    assert worst.format_selector == "worstvideo*+worstaudio/worst"


def test_container_becomes_merge_output_format(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(container="mp4"), settings, binaries, job_dir)
    assert resolution.ydl_opts["merge_output_format"] == "mp4"
    assert resolution.summary["merge_output_format"] == "mp4"


# --- rule 3: the escape hatch ----------------------------------------------


def test_explicit_format_id_wins_when_compatible(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(format_id="137+140"), settings, binaries, job_dir)
    assert resolution.format_selector == "137+140"
    assert resolution.merging is True


def test_audio_only_format_id_is_fine_for_audio_mode(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(mode="audio", format_id="140"), settings, binaries, job_dir)
    assert resolution.format_selector == "140"
    assert resolution.merging is False


def test_merged_format_id_with_audio_mode_is_a_format_mode_conflict(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    """The exact shape the spec tells us not to repeat, rejected at the boundary
    rather than failing deep inside yt-dlp."""
    with pytest.raises(ServiceError) as excinfo:
        resolve(req(mode="audio", format_id="137+140"), settings, binaries, job_dir)

    error = excinfo.value
    assert error.code == ErrorCode.FORMAT_MODE_CONFLICT
    assert error.status_code == 400
    assert error.detail == {"format_id": "137+140", "mode": "audio"}


def test_a_single_format_id_avoids_the_merge_entirely(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(format_id="18", embed_thumbnail=False, embed_metadata=False),
        settings,
        binaries,
        job_dir,
    )
    assert resolution.merging is False
    assert resolution.requires_ffmpeg is False


# --- ffmpeg preflight (SPEC §10) -------------------------------------------


def test_mp3_without_ffmpeg_fails_before_downloading_anything(
    settings: Settings, no_ffmpeg: BinaryResolver, job_dir: Path
) -> None:
    with pytest.raises(ServiceError) as excinfo:
        resolve(
            req(mode="audio", audio_format="mp3", embed_thumbnail=False, embed_metadata=False),
            settings,
            no_ffmpeg,
            job_dir,
        )
    error = excinfo.value
    assert error.code == ErrorCode.FFMPEG_MISSING
    assert error.status_code == 503
    assert "audio_format=mp3" in error.detail["reasons"]


def test_a_merge_without_ffmpeg_fails_preflight(
    settings: Settings, no_ffmpeg: BinaryResolver, job_dir: Path
) -> None:
    with pytest.raises(ServiceError) as excinfo:
        resolve(
            req(embed_thumbnail=False, embed_metadata=False), settings, no_ffmpeg, job_dir
        )
    assert excinfo.value.code == ErrorCode.FFMPEG_MISSING
    assert "merge of separate video and audio streams" in excinfo.value.detail["reasons"]


def test_no_ffmpeg_is_fine_when_nothing_needs_it(
    settings: Settings, no_ffmpeg: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(mode="audio", embed_thumbnail=False, embed_metadata=False),
        settings,
        no_ffmpeg,
        job_dir,
    )
    assert resolution.requires_ffmpeg is False
    assert "ffmpeg_location" not in resolution.ydl_opts


@pytest.mark.parametrize(
    ("field", "reason"),
    [
        ("embed_thumbnail", "embed_thumbnail"),
        ("embed_metadata", "embed_metadata"),
    ],
)
def test_each_embed_requires_ffmpeg(
    settings: Settings, no_ffmpeg: BinaryResolver, job_dir: Path, field: str, reason: str
) -> None:
    payload = {"mode": "audio", "embed_thumbnail": False, "embed_metadata": False, field: True}
    with pytest.raises(ServiceError) as excinfo:
        resolve(req(**payload), settings, no_ffmpeg, job_dir)
    assert excinfo.value.code == ErrorCode.FFMPEG_MISSING
    assert reason in excinfo.value.detail["reasons"]


# --- everything else the resolver owns -------------------------------------


def test_ffmpeg_location_is_the_directory_so_ffprobe_is_found(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(), settings, binaries, job_dir)
    assert resolution.ydl_opts["ffmpeg_location"] == str(Path(binaries.ffmpeg.path or "").parent)


def test_js_runtime_is_passed_as_a_dict(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(), settings, binaries, job_dir)
    assert resolution.ydl_opts["js_runtimes"] == {"quickjs": {"path": binaries.js_runtime.path}}


def test_output_template_defaults_and_stays_inside_the_job_directory(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(), settings, binaries, job_dir)
    outtmpl = resolution.ydl_opts["outtmpl"]["default"]
    assert outtmpl.startswith(str(job_dir))
    assert resolution.summary["output_template"] == "%(title)s [%(id)s].%(ext)s"


def test_playlist_gets_an_indexed_template(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(playlist=True), settings, binaries, job_dir)
    assert "playlist_index" in resolution.summary["output_template"]
    assert resolution.ydl_opts["noplaylist"] is False


@pytest.mark.parametrize("template", ["/etc/passwd", "../../escape.%(ext)s", "C:\\windows\\x"])
def test_output_templates_cannot_escape_the_job_directory(template: str) -> None:
    with pytest.raises(ValueError):
        req(output_template=template)


def test_http_chunk_size_is_applied_and_disableable(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(), settings, binaries, job_dir)
    assert resolution.ydl_opts["http_chunk_size"] == 262_144

    disabled = resolve(req(), settings.replace(http_chunk_size=0), binaries, job_dir)
    assert "http_chunk_size" not in disabled.ydl_opts


def test_cookies_from_browser_is_parsed_into_a_tuple(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(), settings.replace(cookies_from_browser="firefox:default"), binaries, job_dir
    )
    assert resolution.ydl_opts["cookiesfrombrowser"] == ("firefox", "default")
    assert resolution.summary["cookies"] == "browser:firefox:default"


def test_a_cookie_file_takes_precedence(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(),
        settings.replace(cookie_file="/tmp/c.txt", cookies_from_browser="firefox"),
        binaries,
        job_dir,
    )
    assert resolution.ydl_opts["cookiefile"] == "/tmp/c.txt"
    assert "cookiesfrombrowser" not in resolution.ydl_opts


def test_subtitle_options_are_wired_through(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(
        req(subtitles=["en", "es"], auto_subtitles=True, embed_subtitles=True),
        settings,
        binaries,
        job_dir,
    )
    assert resolution.ydl_opts["writesubtitles"] is True
    assert resolution.ydl_opts["writeautomaticsub"] is True
    assert resolution.ydl_opts["subtitleslangs"] == ["en", "es"]
    assert "FFmpegEmbedSubtitle" in resolution.summary["postprocessors"]


def test_embedding_subtitles_without_naming_any_means_all_of_them(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(embed_subtitles=True), settings, binaries, job_dir)
    assert resolution.ydl_opts["subtitleslangs"] == ["all"]
    assert resolution.summary["subtitles"] == ["all"]


def test_rate_limit_and_concurrency_are_passed_through(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    resolution = resolve(req(rate_limit=500_000, concurrent_fragments=8), settings, binaries, job_dir)
    assert resolution.ydl_opts["ratelimit"] == 500_000
    assert resolution.ydl_opts["concurrent_fragment_downloads"] == 8


def test_the_summary_echoes_what_the_server_chose_and_what_was_asked(
    settings: Settings, binaries: BinaryResolver, job_dir: Path
) -> None:
    """SPEC §6: an integrator debugs by reading the resolved options, not the source."""
    resolution = resolve(req(mode="audio", audio_format="opus"), settings, binaries, job_dir)
    summary = resolution.summary
    # Opus is served natively, so the selector asks for it before falling back.
    assert summary["format"] == f"bestaudio[acodec=opus]/{AUDIO_SELECTOR}"
    assert summary["mode"] == "audio"
    assert summary["requires_ffmpeg"] is True
    assert summary["requested"]["mode"] == "audio"
    assert summary["requested"]["audio_format"] == "opus"
