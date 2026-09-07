"""SPEC §4 metadata routes and SPEC §1 raw values."""

from __future__ import annotations

from typing import Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service.config import Settings
from inferno_service.extract import InfoCache, normalise_format, normalise_video

from .fake_ytdlp import FakeYoutubeDL, make_info

URL = "https://fake.test/video"


# --- normalisation ----------------------------------------------------------


def test_bytes_are_integers_and_dates_are_iso() -> None:
    video = normalise_video(make_info())
    assert video["formats"][0]["filesize"] == 3_456_789
    assert isinstance(video["formats"][0]["filesize"], int)
    assert video["upload_date"] == "2024-01-15"
    assert video["timestamp"] == 1705276800
    assert video["duration"] == 213.5


def test_channel_following_and_licence_are_normalised() -> None:
    # Both feed the app's video-details view; a missing one must be null
    # rather than absent, so the client can render "unknown" without guessing.
    video = normalise_video(make_info())
    assert video["channel_follower_count"] == 214000
    assert video["license"] == "Standard YouTube licence"

    bare = make_info()
    del bare["channel_follower_count"]
    del bare["license"]
    sparse = normalise_video(bare)
    assert sparse["channel_follower_count"] is None
    assert sparse["license"] is None


def test_codecs_are_passed_through_as_reported_upstream() -> None:
    video = normalise_video(make_info())
    by_id = {f["format_id"]: f for f in video["formats"]}
    assert by_id["137"]["vcodec"] == "avc1.640028"
    assert by_id["137"]["acodec"] == "none"
    assert by_id["140"]["vcodec"] == "none"


def test_has_video_and_has_audio_are_derived_for_the_client() -> None:
    video = normalise_video(make_info())
    by_id = {f["format_id"]: f for f in video["formats"]}
    assert (by_id["137"]["has_video"], by_id["137"]["has_audio"]) == (True, False)
    assert (by_id["140"]["has_video"], by_id["140"]["has_audio"]) == (False, True)
    assert (by_id["18"]["has_video"], by_id["18"]["has_audio"]) == (True, True)


def test_missing_numbers_become_null_not_zero() -> None:
    formatted = normalise_format({"format_id": "x"})
    assert formatted["filesize"] is None
    assert formatted["height"] is None
    assert formatted["fps"] is None


def test_garbage_upload_dates_do_not_raise() -> None:
    assert normalise_video({"upload_date": "nonsense"})["upload_date"] is None
    assert normalise_video({})["upload_date"] is None


# --- routes -----------------------------------------------------------------


def test_info_returns_a_normalised_video(client: TestClient) -> None:
    payload = client.get("/api/v1/info", params={"url": URL}).json()
    assert payload["url"] == URL
    assert payload["playlist"] is None
    assert payload["video"]["id"] == "abc123XYZ_"
    assert payload["video"]["title"] == "Fake Video"
    assert len(payload["video"]["formats"]) == 3
    assert payload["video"]["chapters"][0]["title"] == "Intro"


def test_info_accepts_post_with_the_same_result(client: TestClient) -> None:
    from_get = client.get("/api/v1/info", params={"url": URL}).json()
    from_post = client.post("/api/v1/info", json={"url": URL}).json()
    assert from_post["video"] == from_get["video"]


def test_info_resolves_a_playlist_when_asked(client: TestClient) -> None:
    payload = client.get(
        "/api/v1/info", params={"url": "https://fake.test/playlist", "playlist": True}
    ).json()
    assert payload["video"] is None
    assert payload["playlist"]["count"] == 3
    assert [entry["id"] for entry in payload["playlist"]["entries"]] == [
        "entry1",
        "entry2",
        "entry3",
    ]


def test_formats_returns_only_the_format_table(client: TestClient) -> None:
    payload = client.get("/api/v1/formats", params={"url": URL}).json()
    assert payload["id"] == "abc123XYZ_"
    assert payload["title"] == "Fake Video"
    assert payload["duration"] == 213.5
    assert {f["format_id"] for f in payload["formats"]} == {"137", "140", "18"}
    assert "description" not in payload


def test_subtitles_lists_tracks_and_fetches_nothing(
    client: TestClient, fake_ydl: type[FakeYoutubeDL]
) -> None:
    payload = client.get("/api/v1/subtitles", params={"url": URL}).json()
    assert sorted(payload["subtitles"]) == ["en", "es"]
    assert payload["automatic_captions"]["en"][0]["ext"] == "vtt"
    # Nothing was downloaded: the extraction ran with skip_download.
    assert all(instance.opts.get("skip_download") for instance in fake_ydl.instances)
    assert all(instance.downloaded == [] for instance in fake_ydl.instances)


def test_metadata_extraction_uses_the_js_runtime(
    client: TestClient, fake_ydl: type[FakeYoutubeDL]
) -> None:
    """SPEC §11 step 2: confirm a JS runtime is genuinely being used."""
    client.get("/api/v1/info", params={"url": URL})
    opts = fake_ydl.instances[-1].opts
    assert set(opts["js_runtimes"]) == {"quickjs"}
    assert isinstance(opts["js_runtimes"]["quickjs"], dict)
    assert opts["js_runtimes"]["quickjs"]["path"]


# --- caching ----------------------------------------------------------------


def test_repeat_requests_are_served_from_the_cache(
    client: TestClient, fake_ydl: type[FakeYoutubeDL]
) -> None:
    first = client.get("/api/v1/info", params={"url": URL}).json()
    second = client.get("/api/v1/info", params={"url": URL}).json()
    assert first["cached"] is False
    assert second["cached"] is True
    assert len(fake_ydl.instances) == 1


def test_refresh_bypasses_the_cache(client: TestClient, fake_ydl: type[FakeYoutubeDL]) -> None:
    client.get("/api/v1/info", params={"url": URL})
    payload = client.get("/api/v1/info", params={"url": URL, "refresh": True}).json()
    assert payload["cached"] is False
    assert len(fake_ydl.instances) == 2


def test_a_zero_ttl_disables_the_cache(
    make_client: Callable[..., TestClient],
    settings: Settings,
    fake_ydl: type[FakeYoutubeDL],
) -> None:
    client = make_client(settings.replace(info_cache_ttl=0))
    client.get("/api/v1/info", params={"url": URL})
    payload = client.get("/api/v1/info", params={"url": URL}).json()
    assert payload["cached"] is False
    assert len(fake_ydl.instances) == 2


def test_cache_entries_expire() -> None:
    now = [1000.0]
    cache = InfoCache(ttl=10, clock=lambda: now[0])
    cache.set("k", {"value": 1})
    assert cache.get("k") == {"value": 1}
    now[0] += 11
    assert cache.get("k") is None
    assert len(cache) == 0


def test_the_cache_distinguishes_playlist_requests(
    client: TestClient, fake_ydl: type[FakeYoutubeDL]
) -> None:
    client.get("/api/v1/info", params={"url": URL})
    client.get("/api/v1/info", params={"url": URL, "playlist": True})
    assert len(fake_ydl.instances) == 2


# --- errors -----------------------------------------------------------------


@pytest.mark.parametrize("url", ["notaurl", "ftp://example.test/x", "", "https://"])
def test_rubbish_urls_are_rejected_as_invalid_url(client: TestClient, url: str) -> None:
    response = client.get("/api/v1/info", params={"url": url})
    assert response.status_code in (400, 422)
    assert response.json()["error"]["code"] in ("invalid_url", "invalid_request")


@pytest.mark.parametrize(
    ("path", "code", "status"),
    [
        ("unavailable", "video_unavailable", 404),
        ("potoken", "po_token_required", 403),
        ("network", "network_error", 502),
        ("unsupported", "invalid_url", 400),
        ("nojs", "js_runtime_missing", 503),
    ],
)
def test_extraction_failures_carry_their_code(
    client: TestClient, path: str, code: str, status: int
) -> None:
    response = client.get("/api/v1/info", params={"url": f"https://fake.test/{path}"})
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert response.json()["error"]["message"]


def test_formats_on_a_playlist_url_is_a_clear_error(client: TestClient) -> None:
    response = client.get("/api/v1/formats", params={"url": "https://fake.test/playlist"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_url"
