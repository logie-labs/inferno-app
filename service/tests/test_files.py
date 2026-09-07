"""SPEC §4: file serving stays in the API, with Range so clients can resume.

A remote tool cannot read the output directory, so anything the service produces
has to be reachable over HTTP.
"""

from __future__ import annotations

from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service.config import Settings

from .conftest import wait_for

VIDEO = "https://fake.test/video"


@pytest.fixture
def finished(client: TestClient) -> dict[str, Any]:
    response = client.post("/api/v1/downloads", json={"url": VIDEO})
    return wait_for(client, response.json()["job_id"])


def media_of(job: dict[str, Any]) -> dict[str, Any]:
    return next(entry for entry in job["files"] if entry["name"].endswith(".mp4"))


def test_a_finished_file_is_fetchable_through_the_api(
    client: TestClient, finished: dict[str, Any]
) -> None:
    entry = media_of(finished)
    response = client.get(entry["url"])
    assert response.status_code == 200
    assert len(response.content) == entry["size"]
    assert response.headers["accept-ranges"] == "bytes"
    assert entry["name"] in response.headers["content-disposition"]


def test_the_url_in_the_job_object_is_the_one_that_works(
    client: TestClient, finished: dict[str, Any]
) -> None:
    for entry in finished["files"]:
        assert client.get(entry["url"]).status_code == 200


def test_a_range_request_returns_206_with_the_right_slice(
    client: TestClient, finished: dict[str, Any]
) -> None:
    entry = media_of(finished)
    whole = client.get(entry["url"]).content

    response = client.get(entry["url"], headers={"Range": "bytes=0-9"})
    assert response.status_code == 206
    assert response.content == whole[:10]
    assert response.headers["content-range"] == f"bytes 0-9/{entry['size']}"
    assert response.headers["content-length"] == "10"


def test_an_open_ended_range_runs_to_the_end(
    client: TestClient, finished: dict[str, Any]
) -> None:
    entry = media_of(finished)
    whole = client.get(entry["url"]).content

    response = client.get(entry["url"], headers={"Range": "bytes=10-"})
    assert response.status_code == 206
    assert response.content == whole[10:]
    assert response.headers["content-range"] == f"bytes 10-{entry['size'] - 1}/{entry['size']}"


def test_a_suffix_range_returns_the_last_bytes(
    client: TestClient, finished: dict[str, Any]
) -> None:
    entry = media_of(finished)
    whole = client.get(entry["url"]).content

    response = client.get(entry["url"], headers={"Range": "bytes=-16"})
    assert response.status_code == 206
    assert response.content == whole[-16:]


def test_a_range_past_the_end_is_clamped(client: TestClient, finished: dict[str, Any]) -> None:
    entry = media_of(finished)
    response = client.get(entry["url"], headers={"Range": f"bytes=0-{entry['size'] + 500}"})
    assert response.status_code == 206
    assert len(response.content) == entry["size"]


def test_resuming_reassembles_the_whole_file(
    client: TestClient, finished: dict[str, Any]
) -> None:
    entry = media_of(finished)
    whole = client.get(entry["url"]).content
    midpoint = entry["size"] // 2

    head = client.get(entry["url"], headers={"Range": f"bytes=0-{midpoint - 1}"}).content
    tail = client.get(entry["url"], headers={"Range": f"bytes={midpoint}-"}).content
    assert head + tail == whole


@pytest.mark.parametrize("header", ["bytes=99999999-", "bytes=-0", "bytes=abc", "bytes=5-1"])
def test_an_unsatisfiable_range_is_416_with_the_envelope(
    client: TestClient, finished: dict[str, Any], header: str
) -> None:
    entry = media_of(finished)
    response = client.get(entry["url"], headers={"Range": header})
    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{entry['size']}"
    assert set(response.json()["error"]) == {"code", "message", "detail"}


def test_a_missing_file_is_a_coded_404(client: TestClient, finished: dict[str, Any]) -> None:
    response = client.get(f"/api/v1/downloads/{finished['job_id']}/files/nope.mp4")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "file_not_found"


def test_files_for_an_unknown_job_are_a_job_not_found(client: TestClient) -> None:
    response = client.get("/api/v1/downloads/nope/files/x.mp4")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"


@pytest.mark.parametrize(
    "name",
    [
        "../../../secret.txt",
        "..%2F..%2Fsecret.txt",
        "..%2Fsecret.txt",
        "sub/../../secret.txt",
    ],
)
def test_path_traversal_is_refused(
    client: TestClient, finished: dict[str, Any], settings: Settings, name: str
) -> None:
    secret = settings.resolved_download_dir() / "secret.txt"
    secret.write_text("do not serve me", encoding="utf-8")

    response = client.get(f"/api/v1/downloads/{finished['job_id']}/files/{name}")
    assert response.status_code == 404
    assert b"do not serve me" not in response.content
    # Either the client normalised the path out of our routes entirely, or our
    # own containment check rejected it. Both answer with the one envelope.
    assert response.json()["error"]["code"] in {"file_not_found", "job_not_found", "not_found"}


def test_serve_files_false_turns_the_route_off(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    client = make_client(settings.replace(serve_files=False))
    response = client.post("/api/v1/downloads", json={"url": VIDEO})
    job = wait_for(client, response.json()["job_id"])

    blocked = client.get(media_of(job)["url"])
    assert blocked.status_code == 404
    assert blocked.json()["error"]["code"] == "file_serving_disabled"
    # The job still reports its files; something else is expected to serve them.
    assert job["files"]


def test_names_with_spaces_and_brackets_round_trip(
    client: TestClient, finished: dict[str, Any]
) -> None:
    """The default template produces 'Title [id].ext', so the URL must survive it."""
    entry = media_of(finished)
    assert " " in entry["name"] and "[" in entry["name"]
    assert client.get(entry["url"]).status_code == 200
