"""Locate ffmpeg/ffprobe and the JS runtime, and report what resolved (SPEC §8).

The resolver contract is identical for every binary::

    env override  ->  bundled directory  ->  PATH

``/health`` reports which one won, so a packaging mistake shows up as
``"source": "path"`` on the dev machine instead of hiding until a clean install.

Two details from SPEC §8 that the code exists to honour:

* ffprobe must sit **beside ffmpeg under its plain name**, because yt-dlp
  derives ffprobe's location from ffmpeg's directory. We therefore resolve
  ffmpeg first and look for ffprobe next to it before falling back.
* The JS runtime is passed to yt-dlp as the dict ``{"quickjs": {"path": ...}}``
  (see :mod:`inferno_service.options`), never the CLI's ``RUNTIME:PATH`` string.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .config import Settings

__all__ = ["BinaryInfo", "BinaryResolver", "REPO_VENDOR_DIR"]

#: Where a checked-out or bundled tree keeps its binaries.
REPO_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor"

_IS_WINDOWS = os.name == "nt"
_EXE_SUFFIXES: tuple[str, ...] = (".exe", ".cmd", ".bat", "") if _IS_WINDOWS else ("",)

#: Candidate executable stems for each supported QuickJS build.
_JS_RUNTIME_CANDIDATES: tuple[tuple[str, str], ...] = (
    ("quickjs", "qjs"),
    ("quickjs", "quickjs"),
    ("quickjs", "qjs-ng"),
)

_PROBE_TIMEOUT = 10.0


@dataclass(frozen=True)
class BinaryInfo:
    """One resolved (or unresolved) executable."""

    name: str
    path: str | None = None
    source: str | None = None  # "env" | "bundled" | "path" | None
    version: str | None = None
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def available(self) -> bool:
        return self.path is not None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "path": self.path,
            "source": self.source,
            "version": self.version,
            "available": self.available,
        }
        if self.error:
            payload["error"] = self.error
        payload.update(self.extra)
        return payload


def _probe_version(path: str, args: Sequence[str]) -> tuple[str | None, str | None]:
    """Run ``path args`` and return ``(first_line, error)``.

    Split out as a module-level function so tests can monkeypatch it instead of
    shipping real executables into a temp directory.
    """
    try:
        completed = subprocess.run(
            [path, *args],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if _IS_WINDOWS else 0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, str(exc)
    output = (completed.stdout or "").strip() or (completed.stderr or "").strip()
    if not output:
        return None, f"{Path(path).name} produced no version output"
    return output.splitlines()[0].strip(), None


def _executable_candidates(stem: str) -> Iterable[str]:
    for suffix in _EXE_SUFFIXES:
        yield f"{stem}{suffix}"


def _find_in_dir(directory: Path, stem: str) -> Path | None:
    if not directory.is_dir():
        return None
    for candidate in _executable_candidates(stem):
        path = directory / candidate
        if path.is_file():
            return path
    return None


def _interpret_override(raw: str, stem: str) -> Path | None:
    """An override may name a directory or the binary itself. Accept both.

    ``FFMPEG_DIR`` doubles as the ffprobe override, so an override pointing at
    the ffmpeg binary still has to yield ffprobe from the same directory.
    """
    given = Path(raw).expanduser()
    if given.is_dir():
        return _find_in_dir(given, stem)
    if given.is_file():
        if given.stem.lower() == stem.lower():
            return given
        return _find_in_dir(given.parent, stem)
    # A path with no suffix on Windows, e.g. C:\tools\ffmpeg -> ffmpeg.exe
    for suffix in _EXE_SUFFIXES:
        if suffix:
            candidate = given.with_name(given.name + suffix)
            if candidate.is_file():
                return candidate
    if given.parent.is_dir():
        return _find_in_dir(given.parent, stem)
    return None


class BinaryResolver:
    """Resolves external binaries once and caches the answer.

    One instance lives on the app for its lifetime. ``refresh()`` clears the
    cache, which is what the tests use to re-resolve after changing settings.
    """

    def __init__(self, settings: Settings, vendor_dir: Path | None = None) -> None:
        self._settings = settings
        self._vendor_dir = Path(vendor_dir) if vendor_dir is not None else REPO_VENDOR_DIR
        self._lock = threading.Lock()
        self._cache: dict[str, Any] | None = None

    # --- public surface ----------------------------------------------------

    @property
    def vendor_dir(self) -> Path:
        return self._vendor_dir

    def refresh(self) -> None:
        with self._lock:
            self._cache = None

    def apply_settings(self, settings: Settings) -> None:
        """Adopt new settings and re-resolve, so a changed path takes effect."""
        with self._lock:
            self._settings = settings
            self._cache = None

    @property
    def ffmpeg(self) -> BinaryInfo:
        return self._resolved()["ffmpeg"]

    @property
    def ffprobe(self) -> BinaryInfo:
        return self._resolved()["ffprobe"]

    @property
    def js_runtime(self) -> BinaryInfo:
        return self._resolved()["js_runtime"]

    @property
    def ffmpeg_dir(self) -> str | None:
        """The directory to hand yt-dlp as ``ffmpeg_location``."""
        info = self.ffmpeg
        return str(Path(info.path).parent) if info.path else None

    def js_runtimes_option(self) -> dict[str, dict[str, str]] | None:
        """The yt-dlp ``js_runtimes`` value, or ``None`` when nothing resolved.

        SPEC §8: the library option is a dict of ``{runtime: {config}}`` — the
        inner value must be a dict, never ``None``.
        """
        info = self.js_runtime
        if not info.path:
            return None
        runtime = str(info.extra.get("runtime") or "quickjs")
        return {runtime: {"path": info.path}}

    def health_dict(self) -> dict[str, Any]:
        resolved = self._resolved()
        js = resolved["js_runtime"]
        return {
            "ffmpeg": resolved["ffmpeg"].to_dict(),
            "ffprobe": resolved["ffprobe"].to_dict(),
            "js_runtime": {
                "name": js.extra.get("name"),
                "path": js.path,
                "source": js.source,
                "version": js.version,
                "available": js.available,
                **({"error": js.error} if js.error else {}),
            },
        }

    # --- resolution --------------------------------------------------------

    def _resolved(self) -> dict[str, Any]:
        with self._lock:
            if self._cache is None:
                self._cache = self._resolve_all()
            return self._cache

    def _resolve_all(self) -> dict[str, BinaryInfo]:
        ffmpeg = self._resolve_ffmpeg()
        ffprobe = self._resolve_ffprobe(ffmpeg)
        return {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "js_runtime": self._resolve_js_runtime()}

    def _search(self, stem: str, override: str | None, bundled_subdir: str) -> tuple[Path | None, str | None]:
        """env override -> bundled directory -> PATH."""
        if override:
            found = _interpret_override(override, stem)
            if found is not None:
                return found, "env"
            # An explicit override that does not resolve is a configuration
            # error worth surfacing rather than silently falling through.
            return None, "env"

        bundled = _find_in_dir(self._vendor_dir / bundled_subdir, stem)
        if bundled is not None:
            return bundled, "bundled"

        on_path = shutil.which(stem)
        if on_path:
            return Path(on_path), "path"
        return None, None

    def _resolve_ffmpeg(self) -> BinaryInfo:
        path, source = self._search("ffmpeg", self._settings.ffmpeg_dir, "ffmpeg")
        if path is None:
            message = (
                f"FFMPEG_DIR={self._settings.ffmpeg_dir!r} does not contain ffmpeg"
                if source == "env"
                else "ffmpeg not found in FFMPEG_DIR, the bundled vendor directory, or PATH"
            )
            return BinaryInfo("ffmpeg", error=message)
        version, error = _probe_version(str(path), ["-version"])
        return BinaryInfo("ffmpeg", str(path), source, _clean_ffmpeg_version(version), error)

    def _resolve_ffprobe(self, ffmpeg: BinaryInfo) -> BinaryInfo:
        # SPEC §8: ffprobe must sit beside ffmpeg under its plain name, because
        # yt-dlp derives its location from ffmpeg's directory.
        if ffmpeg.path:
            beside = _find_in_dir(Path(ffmpeg.path).parent, "ffprobe")
            if beside is not None:
                version, error = _probe_version(str(beside), ["-version"])
                return BinaryInfo(
                    "ffprobe", str(beside), ffmpeg.source, _clean_ffmpeg_version(version), error
                )

        path, source = self._search("ffprobe", self._settings.ffmpeg_dir, "ffmpeg")
        if path is None:
            return BinaryInfo(
                "ffprobe",
                error="ffprobe not found beside ffmpeg, in the bundled vendor directory, or on PATH",
            )
        info_error = None
        if ffmpeg.path and Path(path).parent != Path(ffmpeg.path).parent:
            # Still usable by us, but yt-dlp will not find it on its own.
            info_error = (
                "ffprobe is not in the same directory as ffmpeg; yt-dlp derives "
                "ffprobe from the ffmpeg directory and will not find it there"
            )
        version, probe_error = _probe_version(str(path), ["-version"])
        return BinaryInfo(
            "ffprobe", str(path), source, _clean_ffmpeg_version(version), info_error or probe_error
        )

    def _resolve_js_runtime(self) -> BinaryInfo:
        override = self._settings.js_runtime_dir
        for runtime, stem in _JS_RUNTIME_CANDIDATES:
            path, source = self._search(stem, override, "js")
            if path is None:
                continue
            version, error = _probe_version(str(path), ["--version"])
            name, clean_version = _interpret_js_version(version)
            return BinaryInfo(
                "js_runtime",
                str(path),
                source,
                clean_version,
                error,
                {"runtime": runtime, "name": name},
            )
        message = (
            f"JS_RUNTIME_DIR={override!r} does not contain a QuickJS binary"
            if override
            else "no JavaScript runtime found in JS_RUNTIME_DIR, the bundled vendor directory, or PATH"
        )
        return BinaryInfo("js_runtime", error=message, extra={"runtime": None, "name": None})


def _clean_ffmpeg_version(line: str | None) -> str | None:
    if not line:
        return None
    match = re.search(r"version\s+(\S+)", line)
    return match.group(1) if match else line


def _interpret_js_version(line: str | None) -> tuple[str, str | None]:
    """Identify the QuickJS flavour and version from ``--version`` output.

    The two builds are told apart by their versioning scheme, because neither
    prints its own name: quickjs-ng reports a bare semver (``0.16.2``) while
    Bellard's original QuickJS reports a release date (``2024-01-13``).
    """
    if not line:
        return "quickjs", None
    text = line.strip()
    if "-ng" in text.lower():
        match = re.search(r"(\d+\.\d+(?:\.\d+)?)", text)
        return "quickjs-ng", match.group(1) if match else text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return "quickjs", text
    match = re.fullmatch(r"v?(\d+\.\d+(?:\.\d+)?)", text)
    if match:
        return "quickjs-ng", match.group(1)
    match = re.search(r"(\d+\.\d+(?:\.\d+)?)", text)
    return "quickjs", match.group(1) if match else text
