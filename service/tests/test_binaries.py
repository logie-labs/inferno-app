"""SPEC §8: env override -> bundled directory -> PATH, and honest reporting.

The point of these tests is the sentence in the spec: a packaging mistake should
show up as ``"source": "path"`` on the dev machine instead of hiding until
someone runs a clean install.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from inferno_service.binaries import BinaryResolver, _interpret_js_version
from inferno_service.config import Settings

from .conftest import make_binary


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    return Settings(download_dir=tmp_path / "downloads", **overrides)  # type: ignore[arg-type]


def test_bundled_wins_when_no_override(binaries: BinaryResolver) -> None:
    assert binaries.ffmpeg.available
    assert binaries.ffmpeg.source == "bundled"
    assert binaries.ffprobe.source == "bundled"
    assert binaries.js_runtime.source == "bundled"


def test_env_override_beats_bundled(tmp_path: Path, vendor_dir: Path, isolated_path: None) -> None:
    override_dir = tmp_path / "override"
    make_binary(override_dir, "ffmpeg")
    make_binary(override_dir, "ffprobe")

    resolver = BinaryResolver(
        _settings(tmp_path, ffmpeg_dir=str(override_dir)), vendor_dir=vendor_dir
    )
    assert resolver.ffmpeg.source == "env"
    assert Path(resolver.ffmpeg.path or "").parent == override_dir
    assert Path(resolver.ffprobe.path or "").parent == override_dir


def test_path_is_the_last_resort(tmp_path: Path, empty_vendor_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    on_path = tmp_path / "onpath"
    make_binary(on_path, "ffmpeg")
    make_binary(on_path, "ffprobe")
    monkeypatch.setenv("PATH", str(on_path))
    if os.name == "nt":
        monkeypatch.setenv("PATHEXT", ".EXE")

    resolver = BinaryResolver(_settings(tmp_path), vendor_dir=empty_vendor_dir)
    assert resolver.ffmpeg.source == "path"
    assert resolver.ffprobe.source == "path"


def test_override_may_name_the_binary_itself(tmp_path: Path, vendor_dir: Path, isolated_path: None) -> None:
    override_dir = tmp_path / "override"
    ffmpeg = make_binary(override_dir, "ffmpeg")
    make_binary(override_dir, "ffprobe")

    resolver = BinaryResolver(_settings(tmp_path, ffmpeg_dir=str(ffmpeg)), vendor_dir=vendor_dir)
    assert resolver.ffmpeg.path == str(ffmpeg)
    # SPEC §8: ffprobe is derived from ffmpeg's directory, so pointing the
    # override at the ffmpeg binary must still yield ffprobe beside it.
    assert Path(resolver.ffprobe.path or "").parent == override_dir


def test_ffprobe_is_taken_from_beside_ffmpeg(
    tmp_path: Path, empty_vendor_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """yt-dlp derives ffprobe's location from ffmpeg's directory, so a stray
    ffprobe elsewhere on PATH must not win over the one beside ffmpeg."""
    bundle = tmp_path / "bundle"
    make_binary(bundle, "ffmpeg")
    beside = make_binary(bundle, "ffprobe")

    stray = tmp_path / "stray"
    make_binary(stray, "ffprobe")
    monkeypatch.setenv("PATH", str(stray))
    if os.name == "nt":
        monkeypatch.setenv("PATHEXT", ".EXE")

    resolver = BinaryResolver(_settings(tmp_path, ffmpeg_dir=str(bundle)), vendor_dir=empty_vendor_dir)
    assert resolver.ffprobe.path == str(beside)
    assert resolver.ffprobe.error is None


def test_an_ffprobe_yt_dlp_cannot_find_is_flagged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bundled ffmpeg with ffprobe only on PATH still works for us, but yt-dlp
    derives ffprobe from ffmpeg's directory and will not find it — so say so."""
    vendor = tmp_path / "vendor"
    make_binary(vendor / "ffmpeg", "ffmpeg")
    stray = tmp_path / "stray"
    make_binary(stray, "ffprobe")
    monkeypatch.setenv("PATH", str(stray))
    if os.name == "nt":
        monkeypatch.setenv("PATHEXT", ".EXE")

    resolver = BinaryResolver(_settings(tmp_path), vendor_dir=vendor)
    assert resolver.ffmpeg.source == "bundled"
    assert resolver.ffprobe.available
    assert resolver.ffprobe.source == "path"
    assert "same directory" in (resolver.ffprobe.error or "")


def test_an_override_without_ffprobe_does_not_fall_through_to_path(
    tmp_path: Path, empty_vendor_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit FFMPEG_DIR is a promise about a directory. If ffprobe is not
    in it, yt-dlp will never find one, so silently borrowing a different ffprobe
    from PATH would hide the packaging mistake §8 is about."""
    bundle = tmp_path / "bundle"
    make_binary(bundle, "ffmpeg")
    stray = tmp_path / "stray"
    make_binary(stray, "ffprobe")
    monkeypatch.setenv("PATH", str(stray))
    if os.name == "nt":
        monkeypatch.setenv("PATHEXT", ".EXE")

    resolver = BinaryResolver(
        _settings(tmp_path, ffmpeg_dir=str(bundle)), vendor_dir=empty_vendor_dir
    )
    assert resolver.ffmpeg.available is True
    assert resolver.ffprobe.available is False
    assert resolver.ffprobe.error


def test_nothing_resolves_is_reported_not_raised(no_ffmpeg: BinaryResolver) -> None:
    assert no_ffmpeg.ffmpeg.available is False
    assert no_ffmpeg.ffmpeg.source is None
    assert no_ffmpeg.ffmpeg.error
    assert no_ffmpeg.ffmpeg_dir is None
    assert no_ffmpeg.js_runtimes_option() is None


def test_a_broken_override_does_not_silently_fall_through(
    tmp_path: Path, vendor_dir: Path, isolated_path: None
) -> None:
    resolver = BinaryResolver(
        _settings(tmp_path, ffmpeg_dir=str(tmp_path / "nope")), vendor_dir=vendor_dir
    )
    assert resolver.ffmpeg.available is False
    assert "does not contain ffmpeg" in (resolver.ffmpeg.error or "")


def test_js_runtimes_option_is_a_dict_of_dicts(binaries: BinaryResolver) -> None:
    """SPEC §8: the library option is a dict, not the CLI's RUNTIME:PATH string,
    and the value must be a dict rather than None."""
    option = binaries.js_runtimes_option()
    assert isinstance(option, dict)
    assert set(option) == {"quickjs"}
    assert isinstance(option["quickjs"], dict)
    assert option["quickjs"]["path"] == binaries.js_runtime.path


def test_versions_are_probed_and_cleaned(binaries: BinaryResolver) -> None:
    assert binaries.ffmpeg.version == "7.1"
    assert binaries.ffprobe.version == "7.1"
    assert binaries.js_runtime.version == "0.16.2"
    assert binaries.js_runtime.extra["name"] == "quickjs-ng"


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        # What the real quickjs-ng binary actually prints: a bare semver.
        ("0.16.2", ("quickjs-ng", "0.16.2")),
        ("v0.16.2", ("quickjs-ng", "0.16.2")),
        ("quickjs-ng version 0.16.2", ("quickjs-ng", "0.16.2")),
        # Bellard's original QuickJS versions by release date.
        ("2024-01-13", ("quickjs", "2024-01-13")),
        (None, ("quickjs", None)),
    ],
)
def test_the_quickjs_flavour_is_read_from_its_versioning_scheme(
    output: str | None, expected: tuple[str, str | None]
) -> None:
    assert _interpret_js_version(output) == expected


def test_health_dict_reports_which_source_won(binaries: BinaryResolver) -> None:
    health = binaries.health_dict()
    assert health["ffmpeg"]["source"] == "bundled"
    assert health["ffprobe"]["source"] == "bundled"
    assert health["js_runtime"]["name"] == "quickjs-ng"
    assert health["js_runtime"]["available"] is True


def test_refresh_re_resolves(tmp_path: Path, empty_vendor_dir: Path, isolated_path: None) -> None:
    resolver = BinaryResolver(_settings(tmp_path), vendor_dir=empty_vendor_dir)
    assert resolver.ffmpeg.available is False

    make_binary(empty_vendor_dir / "ffmpeg", "ffmpeg")
    make_binary(empty_vendor_dir / "ffmpeg", "ffprobe")
    assert resolver.ffmpeg.available is False, "results should be cached until refreshed"

    resolver.refresh()
    assert resolver.ffmpeg.available is True


def test_yt_dlp_can_see_mutagen() -> None:
    """Cover art depends on it, and its absence is silent.

    yt-dlp imports mutagen through `yt_dlp.dependencies`, which swallows the
    ImportError and leaves the name None. Nothing fails at startup; the m4a
    thumbnail path just falls back to an ffmpeg remux whose `-disposition`
    index is computed before `-dn` drops the chapter stream that
    `FFmpegMetadata` added - so embedding a thumbnail *and* chapters into one
    m4a dies with "Conversion failed!". For ogg/opus/flac there is no fallback
    at all.

    Asserted through yt-dlp's own accessor rather than a bare `import mutagen`,
    because what matters is that *yt-dlp* found it.
    """
    from yt_dlp.dependencies import mutagen

    assert mutagen is not None, (
        "mutagen is missing, so cover art will silently fail in packaged builds"
    )
