"""Machine-readable errors (SPEC §3, §10).

Every failure carries a stable ``code``. A client must never have to parse
English prose to react correctly, so the classification of yt-dlp's very
prose-y exceptions happens here, once, and nowhere else.

The codes in SPEC §10 are all present. A few more exist because the boundary
needs them and the table does not cover them: ``invalid_request`` (a malformed
body or an unknown field, see SPEC §4), ``unauthorized`` (a bad or missing API
token), ``file_not_found`` / ``file_serving_disabled`` (the file route) and
``internal_error`` (an unclassified crash, so even a bug produces the envelope).
"""

from __future__ import annotations

import errno
import re
from typing import Any, Mapping

__all__ = ["ErrorCode", "ServiceError", "error_envelope", "classify_exception"]


class ErrorCode:
    """Stable error codes. Plain strings so they serialise without ceremony."""

    INVALID_URL = "invalid_url"
    UNSUPPORTED_SITE = "unsupported_site"
    VIDEO_UNAVAILABLE = "video_unavailable"
    FORMAT_UNAVAILABLE = "format_unavailable"
    FORMAT_MODE_CONFLICT = "format_mode_conflict"
    PO_TOKEN_REQUIRED = "po_token_required"
    FFMPEG_MISSING = "ffmpeg_missing"
    #: ffmpeg ran and failed. Distinct from FFMPEG_MISSING, which means it was
    #: never there - the two send someone looking in completely different
    #: places, so conflating them wastes their time.
    POSTPROCESSING_FAILED = "postprocessing_failed"
    JS_RUNTIME_MISSING = "js_runtime_missing"
    NETWORK_ERROR = "network_error"
    DISK_ERROR = "disk_error"
    JOB_NOT_FOUND = "job_not_found"
    CANCELLED = "cancelled"

    # Boundary codes beyond the SPEC §10 table.
    INVALID_REQUEST = "invalid_request"
    UNAUTHORIZED = "unauthorized"
    FILE_NOT_FOUND = "file_not_found"
    FILE_SERVING_DISABLED = "file_serving_disabled"
    #: A setting is pinned by an environment variable and cannot be patched.
    SETTING_LOCKED = "setting_locked"
    NOT_FOUND = "not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    HTTP_ERROR = "http_error"
    INTERNAL_ERROR = "internal_error"


#: Codes for failures raised by the framework before a route runs, so that even
#: an unknown path answers with the SPEC §10 envelope rather than a bare detail.
CODE_FOR_STATUS: dict[int, str] = {
    400: ErrorCode.INVALID_REQUEST,
    401: ErrorCode.UNAUTHORIZED,
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.METHOD_NOT_ALLOWED,
    422: ErrorCode.INVALID_REQUEST,
}


#: Default HTTP status for each code, used when a raiser does not pick one.
STATUS_FOR_CODE: dict[str, int] = {
    ErrorCode.INVALID_URL: 400,
    ErrorCode.UNSUPPORTED_SITE: 400,
    ErrorCode.VIDEO_UNAVAILABLE: 404,
    ErrorCode.FORMAT_UNAVAILABLE: 400,
    ErrorCode.FORMAT_MODE_CONFLICT: 400,
    ErrorCode.PO_TOKEN_REQUIRED: 403,
    ErrorCode.FFMPEG_MISSING: 503,
    ErrorCode.POSTPROCESSING_FAILED: 500,
    ErrorCode.JS_RUNTIME_MISSING: 503,
    ErrorCode.NETWORK_ERROR: 502,
    ErrorCode.DISK_ERROR: 500,
    ErrorCode.JOB_NOT_FOUND: 404,
    ErrorCode.CANCELLED: 409,
    ErrorCode.INVALID_REQUEST: 422,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FILE_NOT_FOUND: 404,
    ErrorCode.FILE_SERVING_DISABLED: 404,
    ErrorCode.SETTING_LOCKED: 409,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.METHOD_NOT_ALLOWED: 405,
    ErrorCode.HTTP_ERROR: 400,
    ErrorCode.INTERNAL_ERROR: 500,
}


class ServiceError(Exception):
    """An error with a stable code, ready to become the SPEC §10 envelope."""

    def __init__(
        self,
        code: str,
        message: str,
        detail: Mapping[str, Any] | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail: dict[str, Any] = dict(detail or {})
        self.status_code = status_code or STATUS_FOR_CODE.get(code, 400)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "detail": self.detail}

    def envelope(self) -> dict[str, Any]:
        return {"error": self.to_dict()}

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ServiceError(code={self.code!r}, message={self.message!r})"


def error_envelope(
    code: str, message: str, detail: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """The one error envelope, used by handlers and by failed job objects."""
    return {"error": {"code": code, "message": message, "detail": dict(detail or {})}}


# --- yt-dlp exception classification ---------------------------------------
#
# yt-dlp reports nearly everything as a DownloadError wrapping a string. The
# patterns below turn that string into a code exactly once. Order matters: the
# more specific diagnoses are tried before the general ones.

_PO_TOKEN_PATTERNS = (
    r"po[_ ]?token",
    r"sabr",
    r"content is not available on this app",
    r"please sign in",
    r"failed to extract any player response",
)

_UNAVAILABLE_PATTERNS = (
    # Both of yt-dlp's phrasings. It says "Video unavailable" for some player
    # responses and "This video is unavailable" for others, and matching only
    # the first sent the second all the way to `internal_error` - so a perfectly
    # ordinary taken-down video was reported as a bug in the app.
    r"video (is )?unavailable",
    r"private video",
    r"this video is private",
    r"members[- ]only",
    r"has been removed",
    r"account associated with this video has been terminated",
    r"sign in to confirm your age",
    r"age[- ]restricted",
    # Covers both "is not available in your country" and yt-dlp's
    # "The uploader has not made this video available in your country".
    r"available in your country",
    r"geo[- ]?restricted",
    r"blocked it in your country",
    r"is not available",
    r"has been terminated",
    r"removed for violating",
)

_FORMAT_PATTERNS = (
    r"requested format (is )?not available",
    r"no video formats found",
    r"requested format_id",
)

_NETWORK_PATTERNS = (
    r"unable to download (web)?page",
    r"connection (reset|refused|aborted|timed out)",
    r"temporary failure in name resolution",
    r"read timed out",
    r"timed out",
    r"network is unreachable",
    r"getaddrinfo failed",
    r"remote end closed connection",
    r"ssl",
    r"handshake",
    r"unable to connect",
    r"http error 5\d\d",
    r"too many requests",
)

_JS_RUNTIME_PATTERNS = (
    r"no supported javascript (interpreter|runtime)",
    r"js ?runtime",
    r"jsinterp",
    r"requires a javascript",
    r"could not find (deno|node|bun|quickjs)",
)

#: Only the phrasings that actually mean "the binary is not there".
#:
#: `postprocessing:.*ffmpeg` used to live here, and it matched yt-dlp's generic
#: `ERROR: Postprocessing: ...` prefix - so *every* ffmpeg failure, whatever the
#: real cause, was reported as a missing installation. That sent people hunting
#: for a packaging fault while the actual message was thrown away.
_FFMPEG_PATTERNS = (
    r"ffmpeg (or avconv )?(is )?not (installed|found)",
    r"ffprobe (or avprobe )?(is )?not (installed|found)",
    r"ffmpeg is not installed",
    r"you have requested merging.*but ffmpeg is not installed",
)

#: ffmpeg ran and something went wrong. Checked after the missing-binary
#: patterns, so a genuine absence still wins.
_POSTPROCESSING_PATTERNS = (
    r"postprocessing:",
    r"you have requested merging.*ffmpeg",
    r"conversion failed",
    r"error while (decoding|encoding|filtering)",
    r"invalid data found when processing input",
)

_UNSUPPORTED_PATTERNS = (
    r"unsupported url",
    r"no suitable extractor",
)

_REFUSED_PATTERNS = (
    r"refused to (handle|process) (the )?url",
    r"this extractor does not support",
    r"does not support this url",
)

_DISK_PATTERNS = (
    r"no space left",
    r"permission denied",
    r"unable to open (file|for writing)",
    r"unable to (create|rename|write)",
    r"disk quota",
    r"read-only file system",
    r"file name too long",
)


def _matches(text: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def _root_cause(exc: BaseException) -> BaseException:
    """Follow yt-dlp's ``exc_info`` chain (and ``__cause__``) to the real error."""
    seen: set[int] = set()
    current: BaseException = exc
    while id(current) not in seen:
        seen.add(id(current))
        info = getattr(current, "exc_info", None)
        candidate: BaseException | None = None
        if isinstance(info, tuple) and len(info) > 1 and isinstance(info[1], BaseException):
            candidate = info[1]
        elif isinstance(current.__cause__, BaseException):
            candidate = current.__cause__
        if candidate is None or candidate is current:
            break
        current = candidate
    return current


def classify_exception(exc: BaseException, *, context: str = "download") -> ServiceError:
    """Turn any exception raised by yt-dlp into a coded :class:`ServiceError`.

    ``context`` only phrases the message; it never changes the code.
    """
    if isinstance(exc, ServiceError):
        return exc

    # Imported lazily so this module stays importable without yt-dlp present.
    try:
        from yt_dlp.utils import DownloadCancelled, UnsupportedError
    except Exception:  # pragma: no cover - yt-dlp is a hard dependency
        download_cancelled: tuple[type, ...] = ()
        unsupported: tuple[type, ...] = ()
    else:
        download_cancelled = (DownloadCancelled,)
        unsupported = (UnsupportedError,)

    if download_cancelled and isinstance(exc, download_cancelled):
        return ServiceError(ErrorCode.CANCELLED, "The job was cancelled.")

    root = _root_cause(exc)

    if isinstance(root, OSError) and not isinstance(root, (ConnectionError, TimeoutError)):
        disk_errnos = {
            errno.ENOSPC,
            errno.EACCES,
            errno.EPERM,
            errno.EROFS,
            errno.ENAMETOOLONG,
            getattr(errno, "EDQUOT", errno.ENOSPC),
        }
        if root.errno in disk_errnos:
            return ServiceError(
                ErrorCode.DISK_ERROR,
                f"Writing to disk failed: {root.strerror or root}",
                {"errno": root.errno, "filename": getattr(root, "filename", None)},
            )

    if isinstance(root, (ConnectionError, TimeoutError)):
        return ServiceError(ErrorCode.NETWORK_ERROR, f"Network failure during {context}: {root}")

    if unsupported and isinstance(exc, unsupported):
        return ServiceError(
            ErrorCode.INVALID_URL,
            "No yt-dlp extractor matches this URL.",
            {"reason": str(exc)},
        )

    # yt-dlp usually wraps its own message, so `exc` and `root` are the same
    # sentence twice. Both are searched, but only distinct ones are joined -
    # an unclassified failure quotes `text` at the user, and saying it twice
    # reads like a glitch.
    outer, inner = str(exc).strip(), str(root).strip()
    text = outer if inner in ("", outer) or inner in outer else f"{outer} {inner}"
    detail: dict[str, Any] = {"reason": str(exc)}

    if _matches(text, _PO_TOKEN_PATTERNS):
        return ServiceError(
            ErrorCode.PO_TOKEN_REQUIRED,
            "YouTube refused or capped this download without a PO token. Configure "
            "COOKIES_FROM_BROWSER or COOKIE_FILE, or attach a PO token provider.",
            detail,
        )
    if _matches(text, _UNSUPPORTED_PATTERNS):
        return ServiceError(ErrorCode.INVALID_URL, "No yt-dlp extractor matches this URL.", detail)
    if _matches(text, _REFUSED_PATTERNS):
        return ServiceError(
            ErrorCode.UNSUPPORTED_SITE, "An extractor matched but refused this URL.", detail
        )
    if _matches(text, _JS_RUNTIME_PATTERNS):
        return ServiceError(
            ErrorCode.JS_RUNTIME_MISSING,
            "Extraction needs a JavaScript runtime and none resolved. Set JS_RUNTIME_DIR.",
            detail,
        )
    if _matches(text, _FFMPEG_PATTERNS):
        return ServiceError(
            ErrorCode.FFMPEG_MISSING,
            "This job needs ffmpeg and none resolved. Set FFMPEG_DIR.",
            detail,
        )
    if _matches(text, _POSTPROCESSING_PATTERNS):
        # Pass ffmpeg's own words through: they are the only thing that says
        # what actually went wrong.
        return ServiceError(
            ErrorCode.POSTPROCESSING_FAILED,
            f"Converting the file failed: {text}",
            detail,
        )
    if _matches(text, _FORMAT_PATTERNS):
        return ServiceError(
            ErrorCode.FORMAT_UNAVAILABLE,
            "The requested format does not exist for this video.",
            detail,
        )
    if _matches(text, _UNAVAILABLE_PATTERNS):
        return ServiceError(
            ErrorCode.VIDEO_UNAVAILABLE,
            "The video is unavailable (private, removed, geo-blocked or age-gated).",
            detail,
        )
    if _matches(text, _DISK_PATTERNS):
        return ServiceError(ErrorCode.DISK_ERROR, f"Writing to disk failed: {text}", detail)
    if _matches(text, _NETWORK_PATTERNS):
        return ServiceError(
            ErrorCode.NETWORK_ERROR, f"Network failure during {context}: {text}", detail
        )

    return ServiceError(
        ErrorCode.INTERNAL_ERROR,
        f"Unclassified failure during {context}: {text}",
        detail,
        status_code=500,
    )
