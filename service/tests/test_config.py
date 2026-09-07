"""SPEC §9: every setting env-overridable, every setting with a working default."""

from __future__ import annotations

from pathlib import Path

import pytest

from inferno_service.config import Settings


def test_defaults_match_the_spec_table() -> None:
    settings = Settings.from_env({})
    assert settings.download_dir == Path("./downloads")
    assert settings.max_concurrent == 2
    assert settings.job_ttl == 86_400
    assert settings.event_history == 250
    assert settings.progress_interval == 0.25
    assert settings.info_cache_ttl == 300
    assert settings.api_token is None
    assert settings.cors_origins == ("*",)
    assert settings.ffmpeg_dir is None
    assert settings.js_runtime_dir is None
    assert settings.cookies_from_browser is None
    assert settings.cookie_file is None
    assert settings.http_chunk_size == 262_144
    assert settings.serve_files is True
    assert settings.auth_required is False


def test_every_variable_is_overridable() -> None:
    settings = Settings.from_env(
        {
            "DOWNLOAD_DIR": "/tmp/dl",
            "MAX_CONCURRENT": "8",
            "JOB_TTL": "60",
            "EVENT_HISTORY": "10",
            "PROGRESS_INTERVAL": "0.5",
            "INFO_CACHE_TTL": "0",
            "API_TOKEN": "s3cret",
            "CORS_ORIGINS": "http://a.test, http://b.test",
            "FFMPEG_DIR": "/opt/ffmpeg",
            "JS_RUNTIME_DIR": "/opt/js",
            "COOKIES_FROM_BROWSER": "firefox",
            "COOKIE_FILE": "/tmp/cookies.txt",
            "HTTP_CHUNK_SIZE": "0",
            "SERVE_FILES": "false",
        }
    )
    assert settings.download_dir == Path("/tmp/dl")
    assert settings.max_concurrent == 8
    assert settings.job_ttl == 60
    assert settings.event_history == 10
    assert settings.progress_interval == 0.5
    assert settings.info_cache_ttl == 0
    assert settings.api_token == "s3cret"
    assert settings.auth_required is True
    assert settings.cors_origins == ("http://a.test", "http://b.test")
    assert settings.ffmpeg_dir == "/opt/ffmpeg"
    assert settings.js_runtime_dir == "/opt/js"
    assert settings.cookies_from_browser == "firefox"
    assert settings.cookie_file == "/tmp/cookies.txt"
    assert settings.http_chunk_size == 0
    assert settings.serve_files is False


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_truthy_booleans(value: str) -> None:
    assert Settings.from_env({"SERVE_FILES": value}).serve_files is True


@pytest.mark.parametrize("value", ["0", "false", "No", "off"])
def test_falsy_booleans(value: str) -> None:
    assert Settings.from_env({"SERVE_FILES": value}).serve_files is False


def test_blank_values_fall_back_to_defaults() -> None:
    settings = Settings.from_env({"API_TOKEN": "   ", "MAX_CONCURRENT": ""})
    assert settings.api_token is None
    assert settings.max_concurrent == 2


def test_bad_numbers_are_rejected_loudly() -> None:
    with pytest.raises(ValueError, match="MAX_CONCURRENT"):
        Settings.from_env({"MAX_CONCURRENT": "lots"})
    with pytest.raises(ValueError, match="SERVE_FILES"):
        Settings.from_env({"SERVE_FILES": "maybe"})


def test_concurrency_and_history_have_floors() -> None:
    settings = Settings.from_env({"MAX_CONCURRENT": "0", "EVENT_HISTORY": "0"})
    assert settings.max_concurrent == 1
    assert settings.event_history == 1
