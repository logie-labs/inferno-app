"""The single seam between this service and the yt-dlp library.

Everything that constructs a ``YoutubeDL`` goes through :func:`build_ydl`.
Keeping it to one function means the test suite can substitute a fake that
drives the very same progress hooks, postprocessor hooks and exceptions without
touching the network — and it means there is exactly one place to look when
yt-dlp's constructor changes.
"""

from __future__ import annotations

from typing import Any, Protocol

__all__ = ["build_ydl", "ytdlp_version", "DownloadCancelled", "YtDlpLike"]


class YtDlpLike(Protocol):
    """The slice of ``yt_dlp.YoutubeDL`` this service actually uses."""

    def extract_info(self, url: str, download: bool = ...) -> dict[str, Any] | None: ...

    def __enter__(self) -> "YtDlpLike": ...

    def __exit__(self, *exc: Any) -> None: ...


def build_ydl(opts: dict[str, Any]) -> YtDlpLike:
    """Construct a ``YoutubeDL``. Patch this in tests to avoid the network."""
    import yt_dlp

    return yt_dlp.YoutubeDL(opts)


def ytdlp_version() -> str | None:
    try:
        import yt_dlp

        return str(yt_dlp.version.__version__)
    except Exception:  # pragma: no cover - yt-dlp is a hard dependency
        return None


def _download_cancelled() -> type[Exception]:
    from yt_dlp.utils import DownloadCancelled as _DownloadCancelled

    return _DownloadCancelled


class _LazyCancelled:
    """``DownloadCancelled`` without importing yt-dlp at module import time."""

    def __call__(self, *args: Any) -> Exception:
        return _download_cancelled()(*args)

    def __instancecheck__(self, instance: Any) -> bool:  # pragma: no cover - trivial
        return isinstance(instance, _download_cancelled())


DownloadCancelled = _LazyCancelled()
