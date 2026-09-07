"""SPEC §6 job lifecycle, and SPEC §7 enforced at the API boundary."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service.config import Settings

from .conftest import wait_for
from .fake_ytdlp import FakeYoutubeDL

VIDEO = "https://fake.test/video"
SLOW = "https://fake.test/slow"


def queue(client: TestClient, url: str = VIDEO, **body: Any) -> dict[str, Any]:
    response = client.post("/api/v1/downloads", json={"url": url, **body})
    assert response.status_code == 202, response.text
    return response.json()


# --- queueing ---------------------------------------------------------------


def test_post_returns_202_immediately_with_a_ws_url(client: TestClient) -> None:
    job = queue(client)
    assert job["status"] in {"queued", "extracting", "downloading"}
    assert job["ws_url"] == f"ws://testserver/ws/downloads/{job['job_id']}"
    assert job["files"] == []
    assert job["finished_at"] is None


def test_the_job_echoes_resolved_options_not_the_ones_sent(client: TestClient) -> None:
    """SPEC §6: a client asking for mode audio should see the selector chosen."""
    job = queue(client, url="https://fake.test/audio", mode="audio", audio_format="mp3")
    options = job["options"]
    assert options["format"] == "bestaudio/best"
    assert "+" not in options["format"]
    assert options["audio_format"] == "mp3"
    assert options["postprocessors"][0] == "FFmpegExtractAudio"
    assert options["requested"]["mode"] == "audio"


# --- happy path -------------------------------------------------------------


def test_a_download_runs_to_completion_and_reports_files(client: TestClient) -> None:
    job = wait_for(client, queue(client)["job_id"])
    assert job["status"] == "completed"
    assert job["error"] is None
    assert job["started_at"] and job["finished_at"]
    assert job["elapsed"] is not None

    names = {entry["name"] for entry in job["files"]}
    assert "Fake Video [abc123XYZ_].mp4" in names
    for entry in job["files"]:
        assert entry["size"] > 0
        assert entry["url"].startswith(f"/api/v1/downloads/{job['job_id']}/files/")


def test_files_and_job_carry_local_paths_for_open_and_reveal(
    client: TestClient, settings: Settings
) -> None:
    # SPEC §4.5: reading a file goes through its URL, but a local client needs
    # a real path to hand the OS for "open" and "reveal in folder".
    job = wait_for(client, queue(client)["job_id"])

    directory = Path(job["directory"])
    assert directory.is_dir()
    assert directory.is_relative_to(settings.resolved_download_dir())

    for entry in job["files"]:
        path = Path(entry["path"])
        assert path.is_file()
        assert path.is_relative_to(directory)
        # The path and the URL must name the same artefact.
        assert path.relative_to(directory).as_posix() == entry["name"]


def test_intermediate_stream_files_are_not_reported(client: TestClient) -> None:
    job = wait_for(client, queue(client)["job_id"])
    assert not any(".f137." in entry["name"] for entry in job["files"])


def test_the_finished_job_carries_normalised_metadata(client: TestClient) -> None:
    job = wait_for(client, queue(client)["job_id"])
    assert job["video"]["id"] == "abc123XYZ_"
    assert job["video"]["upload_date"] == "2024-01-15"


def test_progress_is_recorded_in_raw_units(client: TestClient) -> None:
    job = wait_for(client, queue(client)["job_id"])
    progress = job["progress"]
    assert progress["status"] == "finished"
    assert isinstance(progress["downloaded_bytes"], int)
    assert progress["format_id"] in {"137", "140"}


def test_an_audio_job_produces_the_requested_codec(client: TestClient) -> None:
    job = wait_for(
        client,
        queue(client, url="https://fake.test/audio", mode="audio", audio_format="mp3")["job_id"],
    )
    assert job["status"] == "completed"
    assert any(entry["name"].endswith(".mp3") for entry in job["files"])


def test_a_playlist_job_downloads_every_entry(client: TestClient) -> None:
    job = wait_for(client, queue(client, url="https://fake.test/playlist", playlist=True)["job_id"])
    assert job["status"] == "completed"
    media = [entry for entry in job["files"] if entry["name"].endswith(".mp4")]
    assert len(media) == 3
    assert job["playlist"]["count"] == 3


def test_subtitles_and_thumbnails_are_written_when_requested(client: TestClient) -> None:
    job = wait_for(
        client, queue(client, subtitles=["en"], write_thumbnail=True)["job_id"]
    )
    names = {entry["name"] for entry in job["files"]}
    assert any(name.endswith(".en.vtt") for name in names)
    assert any(name.endswith(".webp") for name in names)


# --- listing ----------------------------------------------------------------


def test_jobs_are_listed_newest_first(client: TestClient) -> None:
    first = queue(client)["job_id"]
    second = queue(client)["job_id"]
    wait_for(client, first)
    wait_for(client, second)

    payload = client.get("/api/v1/downloads").json()
    assert [job["job_id"] for job in payload["jobs"]] == [second, first]
    assert payload["count"] == payload["total"] == 2


def test_listing_filters_by_status_and_limit(client: TestClient) -> None:
    for _ in range(3):
        wait_for(client, queue(client)["job_id"])

    completed = client.get("/api/v1/downloads", params={"status": "completed"}).json()
    assert completed["total"] == 3

    limited = client.get("/api/v1/downloads", params={"limit": 2}).json()
    assert limited["count"] == 2
    assert limited["total"] == 3

    empty = client.get("/api/v1/downloads", params={"status": "failed"}).json()
    assert empty["jobs"] == []


def test_an_unknown_status_filter_is_rejected(client: TestClient) -> None:
    response = client.get("/api/v1/downloads", params={"status": "nearly_done"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_an_unknown_job_is_a_job_not_found(client: TestClient) -> None:
    response = client.get("/api/v1/downloads/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"
    assert response.json()["error"]["detail"]["job_id"] == "nope"


# --- cancellation -----------------------------------------------------------


def test_cancel_bites_mid_download(client: TestClient) -> None:
    """SPEC §3: cancel must be responsive mid-download, not merely between jobs."""
    job_id = queue(client, url=SLOW)["job_id"]
    running = wait_for(client, job_id, statuses={"downloading"}, timeout=10)
    assert running["progress"]["percent"] is not None
    assert (running["progress"]["percent"] or 0) < 100

    response = client.post(f"/api/v1/downloads/{job_id}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    assert client.get(f"/api/v1/downloads/{job_id}").json()["status"] == "cancelled"


def test_cancelling_a_queued_job_never_starts_it(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    client = make_client(settings.replace(max_concurrent=1))
    first = queue(client, url=SLOW)["job_id"]
    second = queue(client, url=SLOW)["job_id"]
    wait_for(client, first, statuses={"downloading"}, timeout=10)
    assert client.get(f"/api/v1/downloads/{second}").json()["status"] == "queued"

    assert client.post(f"/api/v1/downloads/{second}/cancel").json()["status"] == "cancelled"
    assert client.get(f"/api/v1/downloads/{second}").json()["started_at"] is None
    client.post(f"/api/v1/downloads/{first}/cancel")


def test_cancelling_a_finished_job_is_a_no_op(client: TestClient) -> None:
    job_id = queue(client)["job_id"]
    wait_for(client, job_id)
    assert client.post(f"/api/v1/downloads/{job_id}/cancel").json()["status"] == "completed"


def test_cancelling_an_unknown_job_is_a_job_not_found(client: TestClient) -> None:
    response = client.post("/api/v1/downloads/nope/cancel")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "job_not_found"


# --- concurrency ------------------------------------------------------------


def test_the_concurrency_cap_queues_the_rest(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    client = make_client(settings.replace(max_concurrent=1))
    first = queue(client, url=SLOW)["job_id"]
    second = queue(client, url=SLOW)["job_id"]
    third = queue(client, url=SLOW)["job_id"]

    wait_for(client, first, statuses={"downloading"}, timeout=10)
    statuses = {
        job["job_id"]: job["status"] for job in client.get("/api/v1/downloads").json()["jobs"]
    }
    assert statuses[first] == "downloading"
    assert statuses[second] == "queued"
    assert statuses[third] == "queued"

    for job_id in (first, second, third):
        client.post(f"/api/v1/downloads/{job_id}/cancel")


def test_two_jobs_run_at_once_when_the_cap_allows(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    client = make_client(settings.replace(max_concurrent=2))
    ids = [queue(client, url=SLOW)["job_id"] for _ in range(2)]
    for job_id in ids:
        wait_for(client, job_id, statuses={"downloading"}, timeout=10)
    for job_id in ids:
        client.post(f"/api/v1/downloads/{job_id}/cancel")


# --- deletion ---------------------------------------------------------------


def test_delete_removes_the_job_and_its_files(client: TestClient, settings: Settings) -> None:
    # Finished files sit directly in the download folder, not in a per-job
    # subdirectory, so deletion has to remove the files themselves.
    job = wait_for(client, queue(client)["job_id"])
    job_id = job["job_id"]
    paths = [Path(entry["path"]) for entry in job["files"]]
    assert paths and all(path.is_file() for path in paths)
    assert all(path.parent == settings.resolved_download_dir() for path in paths)

    assert client.delete(f"/api/v1/downloads/{job_id}").status_code == 204
    assert client.get(f"/api/v1/downloads/{job_id}").status_code == 404
    assert not any(path.exists() for path in paths)
    # The download folder itself is the user's and must survive.
    assert settings.resolved_download_dir().is_dir()


def test_delete_can_keep_the_files(client: TestClient, settings: Settings) -> None:
    job = wait_for(client, queue(client)["job_id"])
    paths = [Path(entry["path"]) for entry in job["files"]]

    client.delete(f"/api/v1/downloads/{job['job_id']}", params={"keep_files": True})
    assert all(path.is_file() for path in paths)


def test_a_second_download_of_the_same_video_is_numbered(client: TestClient) -> None:
    # Two jobs, same video, same folder: the second must not overwrite the
    # first. Numbered the way a browser or file manager would do it.
    first = wait_for(client, queue(client)["job_id"])
    second = wait_for(client, queue(client)["job_id"])

    original = {entry["name"] for entry in first["files"]}
    repeat = {entry["name"] for entry in second["files"]}

    assert original and repeat
    assert not (original & repeat), "the second download reused a name"
    assert any(" (1)" in name for name in repeat)
    # Both sets still exist: nothing was clobbered.
    for entry in first["files"] + second["files"]:
        assert Path(entry["path"]).is_file()


def test_nothing_is_left_in_the_staging_folder(client: TestClient, settings: Settings) -> None:
    wait_for(client, queue(client)["job_id"])
    staging = settings.resolved_download_dir() / ".incomplete"
    # Either gone entirely or empty - never holding a finished job's rubble.
    assert not staging.exists() or not any(staging.iterdir())


def test_delete_cancels_a_running_job_first(client: TestClient) -> None:
    job_id = queue(client, url=SLOW)["job_id"]
    wait_for(client, job_id, statuses={"downloading"}, timeout=10)
    assert client.delete(f"/api/v1/downloads/{job_id}").status_code == 204
    assert client.get(f"/api/v1/downloads/{job_id}").status_code == 404


# --- failures ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "code"),
    [
        ("unavailable", "video_unavailable"),
        ("potoken", "po_token_required"),
        ("network", "network_error"),
        ("disk", "disk_error"),
    ],
)
def test_a_failing_download_ends_failed_with_its_code(
    client: TestClient, path: str, code: str
) -> None:
    job_id = queue(client, url=f"https://fake.test/{path}")["job_id"]
    job = wait_for(client, job_id)
    assert job["status"] == "failed"
    assert job["error"]["code"] == code
    assert job["error"]["message"]


def test_a_format_mode_conflict_is_rejected_at_the_boundary(client: TestClient) -> None:
    """SPEC §7 rule 3, enforced before a job exists at all."""
    response = client.post(
        "/api/v1/downloads",
        json={"url": VIDEO, "mode": "audio", "format_id": "137+140"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "format_mode_conflict"
    assert client.get("/api/v1/downloads").json()["total"] == 0


def test_a_missing_ffmpeg_fails_before_downloading(
    make_client: Callable[..., TestClient], settings: Settings, empty_vendor_dir: Path
) -> None:
    """SPEC §10: do not download 200 MB first and fail in postprocessing."""
    client = make_client(settings, vendor=empty_vendor_dir)
    response = client.post(
        "/api/v1/downloads",
        json={"url": VIDEO, "mode": "audio", "audio_format": "mp3"},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ffmpeg_missing"
    assert "audio_format=mp3" in response.json()["error"]["detail"]["reasons"]
    assert client.get("/api/v1/downloads").json()["total"] == 0


def test_an_invalid_url_never_becomes_a_job(client: TestClient) -> None:
    response = client.post("/api/v1/downloads", json={"url": "not-a-url"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_url"


# --- retention --------------------------------------------------------------


def test_finished_jobs_are_swept_after_their_ttl(client: TestClient, settings: Settings) -> None:
    job_id = queue(client)["job_id"]
    wait_for(client, job_id)
    directory = settings.resolved_download_dir() / job_id

    manager = client.app.state.ctx.jobs
    assert manager.sweep(now=time.time()) == []
    assert manager.sweep(now=time.time() + settings.job_ttl + 1) == [job_id]

    assert client.get(f"/api/v1/downloads/{job_id}").status_code == 404
    assert not directory.exists()


def test_a_running_job_is_never_swept(client: TestClient, settings: Settings) -> None:
    job_id = queue(client, url=SLOW)["job_id"]
    wait_for(client, job_id, statuses={"downloading"}, timeout=10)
    manager = client.app.state.ctx.jobs
    assert manager.sweep(now=time.time() + settings.job_ttl * 10) == []
    client.post(f"/api/v1/downloads/{job_id}/cancel")


# --- the options actually handed to yt-dlp ---------------------------------


def test_the_worker_receives_the_resolved_options(
    client: TestClient, fake_ydl: type[FakeYoutubeDL]
) -> None:
    wait_for(client, queue(client, quality="720p", container="mp4")["job_id"])
    opts = fake_ydl.instances[-1].opts
    assert opts["format"] == "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
    assert opts["merge_output_format"] == "mp4"
    assert opts["ffmpeg_location"]
    assert opts["js_runtimes"]["quickjs"]["path"]
    assert opts["progress_hooks"] and opts["postprocessor_hooks"] and opts["logger"]


def test_the_filename_case_only_touches_the_stem():
    """The suffix is whatever the download turned out to be, not a choice."""
    from inferno_service.jobs import _cased

    assert _cased("Never Gonna Give You Up", "kebab") == "never-gonna-give-you-up"
    assert _cased("Never Gonna Give You Up", "snake") == "never_gonna_give_you_up"
    assert _cased("Never Gonna Give You Up", "lower") == "never gonna give you up"
    assert _cased("never gonna GIVE you up", "title") == "Never Gonna Give You Up"
    assert _cased("Leave It Alone", "original") == "Leave It Alone"


def test_casing_collapses_punctuation_rather_than_repeating_it():
    """`Channel - Title` is one hyphenated run, not a stray triple dash."""
    from inferno_service.jobs import _cased

    assert _cased("Rick Astley - Never Gonna", "kebab") == "rick-astley-never-gonna"
    assert _cased("A  B", "snake") == "a_b"
    # Leading and trailing separators are trimmed rather than left dangling.
    assert _cased("!Hello!", "kebab") == "hello"


def test_a_name_with_nothing_caseable_is_left_as_it_was():
    """Better an odd name than an empty one."""
    from inferno_service.jobs import _cased

    assert _cased("!!!", "kebab") == "!!!"
    assert _cased("", "kebab") == ""
