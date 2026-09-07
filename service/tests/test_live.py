"""Opt-in tests that use the real yt-dlp, the real binaries and the network.

The rest of the suite is hermetic, which is what makes it fast and trustworthy —
but it can only prove the service is correct against a fake. These tests prove
the other half: that the wiring holds against the real thing.

Run them with::

    INFERNO_LIVE=1 pytest -m live

Add ``INFERNO_LIVE_DOWNLOAD=1`` to also pull real bytes, and
``INFERNO_LIVE_URL=<url>`` to choose the subject (the default is a short
Creative Commons clip).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from inferno_service.binaries import REPO_VENDOR_DIR
from inferno_service.config import Settings
from inferno_service.main import create_app

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.environ.get("INFERNO_LIVE") != "1",
        reason="set INFERNO_LIVE=1 to run tests that hit the network",
    ),
]

LIVE_URL = os.environ.get(
    "INFERNO_LIVE_URL", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
)


@pytest.fixture
def live_client(tmp_path: Path) -> TestClient:
    """A real app: real binaries from the repo vendor tree, real yt-dlp."""
    settings = Settings.from_env().replace(
        download_dir=tmp_path / "downloads", info_cache_ttl=0, job_ttl=3600
    )
    with TestClient(create_app(settings, vendor_dir=REPO_VENDOR_DIR)) as client:
        yield client


def test_health_reports_the_real_environment(live_client: TestClient) -> None:
    payload = live_client.get("/health").json()
    assert payload["status"] == "ok"
    assert payload["yt_dlp_version"]
    print(
        f"\nffmpeg: {payload['ffmpeg']} \nffprobe: {payload['ffprobe']}"
        f"\njs_runtime: {payload['js_runtime']}"
    )


def test_binaries_resolve_from_somewhere(live_client: TestClient) -> None:
    """Not a failure if they come from PATH, but SPEC §8 wants that visible."""
    payload = live_client.get("/health").json()
    for name in ("ffmpeg", "ffprobe"):
        if not payload[name]["available"]:
            pytest.skip(f"{name} is not installed anywhere; see the README on vendor/")
        assert payload[name]["source"] in {"env", "bundled", "path"}


def test_real_metadata_extraction(live_client: TestClient) -> None:
    response = live_client.get("/api/v1/info", params={"url": LIVE_URL})
    if response.status_code != 200:
        pytest.skip(f"extraction unavailable right now: {response.json()}")

    video = response.json()["video"]
    assert video["id"]
    assert video["title"]
    assert video["formats"], "no formats came back"


def test_a_js_runtime_is_genuinely_used(live_client: TestClient) -> None:
    """SPEC §8: without a JS runtime, extraction silently degrades and formats
    go missing. This is the check that catches that."""
    health = live_client.get("/health").json()
    if not health["js_runtime"]["available"]:
        pytest.skip("no JS runtime resolved; see the README on vendor/js")

    response = live_client.get("/api/v1/formats", params={"url": LIVE_URL})
    if response.status_code != 200:
        pytest.skip(f"extraction unavailable right now: {response.json()}")

    formats = response.json()["formats"]
    adaptive = [f for f in formats if f["has_video"] and not f["has_audio"]]
    assert adaptive, "only muxed formats came back, which is what missing-JS looks like"


def test_the_format_table_has_real_numbers(live_client: TestClient) -> None:
    response = live_client.get("/api/v1/formats", params={"url": LIVE_URL})
    if response.status_code != 200:
        pytest.skip(f"extraction unavailable right now: {response.json()}")

    formats = response.json()["formats"]
    assert any(isinstance(f["height"], int) for f in formats)
    assert any(f["filesize"] or f["filesize_approx"] for f in formats)


@pytest.mark.skipif(
    os.environ.get("INFERNO_LIVE_DOWNLOAD") != "1",
    reason="set INFERNO_LIVE_DOWNLOAD=1 to pull real bytes",
)
def test_a_real_download_completes_and_serves(live_client: TestClient) -> None:
    from .conftest import wait_for

    response = live_client.post(
        "/api/v1/downloads",
        json={
            "url": LIVE_URL,
            "mode": "video",
            "quality": "360p",
            "embed_thumbnail": False,
            "embed_metadata": False,
        },
    )
    assert response.status_code == 202, response.text

    job = wait_for(live_client, response.json()["job_id"], timeout=300)
    if job["status"] == "failed":
        code = job["error"]["code"]
        if code in {"po_token_required", "network_error", "video_unavailable"}:
            pytest.skip(f"upstream refused the download: {code} — {job['error']['message']}")
        pytest.fail(f"download failed: {job['error']}")

    assert job["status"] == "completed"
    assert job["files"], "completed with no files"

    entry = job["files"][0]
    whole = live_client.get(entry["url"])
    assert whole.status_code == 200
    assert len(whole.content) == entry["size"]

    ranged = live_client.get(entry["url"], headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206
    assert ranged.content == whole.content[:100]
