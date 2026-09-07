"""SPEC §10: every failure carries a stable code.

A client must never have to parse English prose to react correctly, so these
tests pin the translation from yt-dlp's prose to our codes.
"""

from __future__ import annotations

import errno

import pytest
from yt_dlp.utils import DownloadCancelled, DownloadError, UnsupportedError

from inferno_service.errors import (
    ErrorCode,
    ServiceError,
    classify_exception,
    error_envelope,
)


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            "ERROR: unable to download video data: HTTP Error 403: Forbidden. The "
            "following content is not available on this app: a PO Token is required",
            ErrorCode.PO_TOKEN_REQUIRED,
        ),
        ("ERROR: Sign in to confirm you are not a bot. po_token missing", ErrorCode.PO_TOKEN_REQUIRED),
        ("ERROR: Video unavailable. This video is private", ErrorCode.VIDEO_UNAVAILABLE),
        # yt-dlp's other phrasing, straight from a real android_vr response.
        # It used to fall through to `internal_error`, so a taken-down video
        # was reported as though the app had broken.
        (
            "ERROR: [youtube] Pp-OulpXF90: This video is unavailable",
            ErrorCode.VIDEO_UNAVAILABLE,
        ),
        ("ERROR: This video has been removed by the uploader", ErrorCode.VIDEO_UNAVAILABLE),
        ("ERROR: Sign in to confirm your age", ErrorCode.VIDEO_UNAVAILABLE),
        ("ERROR: The uploader has not made this video available in your country", ErrorCode.VIDEO_UNAVAILABLE),
        ("ERROR: Requested format is not available", ErrorCode.FORMAT_UNAVAILABLE),
        ("ERROR: No video formats found!", ErrorCode.FORMAT_UNAVAILABLE),
        ("ERROR: Unsupported URL: https://example.test/thing", ErrorCode.INVALID_URL),
        ("ERROR: No supported JavaScript runtime could be found", ErrorCode.JS_RUNTIME_MISSING),
        ("ERROR: ffmpeg is not installed", ErrorCode.FFMPEG_MISSING),
        (
            "ERROR: You have requested merging of multiple formats but ffmpeg is not installed",
            ErrorCode.FFMPEG_MISSING,
        ),
        ("ERROR: Unable to download webpage: The read operation timed out", ErrorCode.NETWORK_ERROR),
        ("ERROR: [Errno 111] Connection refused", ErrorCode.NETWORK_ERROR),
        ("ERROR: unable to open for writing: No space left on device", ErrorCode.DISK_ERROR),
        ("ERROR: This extractor does not support this URL", ErrorCode.UNSUPPORTED_SITE),
        # ffmpeg running and failing is a different problem from ffmpeg being
        # absent, and must not be reported as a broken installation.
        (
            "ERROR: Postprocessing: Error selecting an encoder for stream 0:0",
            ErrorCode.POSTPROCESSING_FAILED,
        ),
        (
            "ERROR: Postprocessing: ffmpeg exited with code 1",
            ErrorCode.POSTPROCESSING_FAILED,
        ),
        (
            "ERROR: Conversion failed!",
            ErrorCode.POSTPROCESSING_FAILED,
        ),
        (
            "ERROR: Invalid data found when processing input",
            ErrorCode.POSTPROCESSING_FAILED,
        ),
    ],
)
def test_download_errors_get_a_stable_code(message: str, expected: str) -> None:
    assert classify_exception(DownloadError(message)).code == expected


def test_cancellation_is_its_own_terminal_code() -> None:
    error = classify_exception(DownloadCancelled("stopped"))
    assert error.code == ErrorCode.CANCELLED
    assert error.status_code == 409


def test_unsupported_error_maps_to_invalid_url() -> None:
    error = classify_exception(UnsupportedError("https://example.test/nope"))
    assert error.code == ErrorCode.INVALID_URL


def test_os_errors_about_the_disk_are_disk_errors() -> None:
    exc = OSError(errno.ENOSPC, "No space left on device", "/tmp/out.mp4")
    error = classify_exception(exc)
    assert error.code == ErrorCode.DISK_ERROR
    assert error.detail["errno"] == errno.ENOSPC
    assert error.detail["filename"] == "/tmp/out.mp4"


def test_transport_exceptions_are_network_errors() -> None:
    assert classify_exception(ConnectionResetError("boom")).code == ErrorCode.NETWORK_ERROR
    assert classify_exception(TimeoutError("slow")).code == ErrorCode.NETWORK_ERROR


def test_a_wrapped_cause_is_followed() -> None:
    inner = OSError(errno.ENOSPC, "No space left on device")
    outer = DownloadError("ERROR: postprocessing failed", exc_info=(type(inner), inner, None))
    assert classify_exception(outer).code == ErrorCode.DISK_ERROR


def test_an_unclassifiable_failure_still_gets_the_envelope() -> None:
    error = classify_exception(RuntimeError("something odd"))
    assert error.code == ErrorCode.INTERNAL_ERROR
    assert error.status_code == 500
    assert "something odd" in error.message


def test_an_unclassified_message_is_quoted_once_not_twice() -> None:
    # yt-dlp wraps its own message, so the outer and inner exceptions carry the
    # same sentence. An unclassified failure shows that text to the user, and
    # showing it twice reads like a glitch.
    inner = RuntimeError("something nobody has seen")
    outer = DownloadError("ERROR: something nobody has seen", exc_info=(type(inner), inner, None))

    message = classify_exception(outer).message
    assert message.count("something nobody has seen") == 1


def test_a_genuinely_different_cause_is_still_included() -> None:
    inner = RuntimeError("the underlying reason")
    outer = DownloadError("ERROR: the wrapper's own words", exc_info=(type(inner), inner, None))

    message = classify_exception(outer).message
    assert "the wrapper's own words" in message
    assert "the underlying reason" in message


def test_a_service_error_passes_through_untouched() -> None:
    original = ServiceError(ErrorCode.FORMAT_MODE_CONFLICT, "nope", {"a": 1})
    assert classify_exception(original) is original


def test_the_envelope_shape_is_fixed() -> None:
    envelope = ServiceError(ErrorCode.JOB_NOT_FOUND, "gone", {"job_id": "x"}).envelope()
    assert set(envelope) == {"error"}
    assert set(envelope["error"]) == {"code", "message", "detail"}
    assert envelope["error"]["code"] == "job_not_found"


def test_the_helper_produces_the_same_envelope() -> None:
    assert error_envelope("cancelled", "gone") == {
        "error": {"code": "cancelled", "message": "gone", "detail": {}}
    }


@pytest.mark.parametrize(
    ("code", "status"),
    [
        (ErrorCode.INVALID_URL, 400),
        (ErrorCode.FORMAT_MODE_CONFLICT, 400),
        (ErrorCode.VIDEO_UNAVAILABLE, 404),
        (ErrorCode.PO_TOKEN_REQUIRED, 403),
        (ErrorCode.FFMPEG_MISSING, 503),
        (ErrorCode.JS_RUNTIME_MISSING, 503),
        (ErrorCode.NETWORK_ERROR, 502),
        (ErrorCode.DISK_ERROR, 500),
        (ErrorCode.JOB_NOT_FOUND, 404),
        (ErrorCode.UNAUTHORIZED, 401),
    ],
)
def test_each_code_has_a_sensible_default_status(code: str, status: int) -> None:
    assert ServiceError(code, "message").status_code == status


def test_every_spec_code_exists() -> None:
    """The SPEC §10 table, verbatim."""
    expected = {
        "invalid_url",
        "unsupported_site",
        "video_unavailable",
        "format_unavailable",
        "format_mode_conflict",
        "po_token_required",
        "ffmpeg_missing",
        "js_runtime_missing",
        "network_error",
        "disk_error",
        "job_not_found",
        "cancelled",
    }
    declared = {
        value
        for name, value in vars(ErrorCode).items()
        if not name.startswith("_") and isinstance(value, str)
    }
    assert expected <= declared
