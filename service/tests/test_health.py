"""SPEC §8: /health reports real capabilities, so a client adapts instead of guessing."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi.testclient import TestClient

from inferno_service.config import Settings


def test_health_reports_the_spec_fields(client: TestClient) -> None:
    payload = client.get("/health").json()
    for key in (
        "status",
        "version",
        "yt_dlp_version",
        "ffmpeg",
        "ffprobe",
        "js_runtime",
        "cookies",
        "po_token_provider",
        "max_concurrent",
        "jobs",
        "websocket_clients",
    ):
        assert key in payload, key
    assert payload["status"] == "ok"


def test_health_names_the_service_and_the_product(client: TestClient) -> None:
    """A client that finds the port should learn what answered, since the
    service is meant to be spawned as a sidecar by the Inferno desktop app."""
    payload = client.get("/health").json()
    assert payload["service"] == "inferno-service"
    assert payload["product"] == "inferno"


def test_health_says_which_source_won(client: TestClient) -> None:
    payload = client.get("/health").json()
    assert payload["ffmpeg"]["source"] == "bundled"
    assert payload["ffprobe"]["source"] == "bundled"
    assert payload["js_runtime"]["source"] == "bundled"
    assert payload["js_runtime"]["name"] == "quickjs-ng"
    assert payload["js_runtime"]["version"] == "0.16.2"


def test_a_packaging_mistake_shows_up_as_a_missing_binary(
    make_client: Callable[..., TestClient], settings: Settings, empty_vendor_dir: Path
) -> None:
    client = make_client(settings, vendor=empty_vendor_dir)
    payload = client.get("/health").json()
    assert payload["ffmpeg"]["available"] is False
    assert payload["ffmpeg"]["source"] is None
    assert payload["ffmpeg"]["error"]
    assert payload["features"]["merge"] is False
    assert payload["features"]["js_challenges"] is False


def test_health_reports_limits_and_features(client: TestClient, settings: Settings) -> None:
    payload = client.get("/health").json()
    assert payload["max_concurrent"] == settings.max_concurrent
    assert payload["limits"]["event_history"] == settings.event_history
    assert payload["limits"]["info_cache_ttl"] == settings.info_cache_ttl
    assert payload["limits"]["http_chunk_size"] == settings.http_chunk_size
    assert payload["features"]["serve_files"] is True
    assert payload["features"]["auth"] is False


def test_health_counts_jobs_by_status(client: TestClient, wait_for_job: Any) -> None:
    assert client.get("/health").json()["jobs"]["total"] == 0

    response = client.post("/api/v1/downloads", json={"url": "https://fake.test/video"})
    job_id = response.json()["job_id"]
    wait_for_job(client, job_id)

    counts = client.get("/health").json()["jobs"]
    assert counts["total"] == 1
    assert counts["completed"] == 1


def test_cookies_capability_is_reported(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    assert client_cookies(make_client, settings) is False
    assert client_cookies(make_client, settings.replace(cookies_from_browser="firefox")) is True


def client_cookies(make_client: Callable[..., TestClient], settings: Settings) -> bool:
    return bool(make_client(settings).get("/health").json()["cookies"])
