"""The CLI is an ordinary API consumer, so it is tested through the API.

Its HTTP client is swapped for a ``TestClient``, which is itself an
``httpx.Client``. Nothing else about the CLI changes, so what these tests
exercise is the same code path a user gets.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from inferno_service.clients import cli

from .conftest import wait_for

VIDEO = "https://fake.test/video"


@pytest.fixture
def api(client: TestClient) -> cli.Client:
    """A CLI client wired to the in-process app."""
    consumer = cli.Client("http://testserver", None)
    consumer._http.close()
    consumer._http = client  # type: ignore[assignment]
    return consumer


def run(api: cli.Client, argv: list[str]) -> int:
    args = cli.build_parser().parse_args(argv)
    return int(args.fn(api, args))


# --- the client wrapper -----------------------------------------------------


def test_health_round_trips(api: cli.Client) -> None:
    assert api.health()["status"] == "ok"


def test_info_and_formats_round_trip(api: cli.Client) -> None:
    assert api.info(VIDEO)["video"]["id"] == "abc123XYZ_"
    assert len(api.formats(VIDEO)["formats"]) == 3
    assert sorted(api.subtitles(VIDEO)["subtitles"]) == ["en", "es"]


def test_a_full_download_cycle_through_the_client(
    api: cli.Client, client: TestClient, tmp_path: Path
) -> None:
    job = api.create_download({"url": VIDEO})
    wait_for(client, job["job_id"])

    fetched = api.job(job["job_id"])
    assert fetched["status"] == "completed"

    entry = next(f for f in fetched["files"] if f["name"].endswith(".mp4"))
    target = api.fetch_file(job["job_id"], entry["name"], tmp_path / entry["name"])
    assert target.stat().st_size == entry["size"]

    api.delete(job["job_id"])
    assert api.jobs()["total"] == 0


def test_errors_surface_as_coded_api_errors(api: cli.Client) -> None:
    with pytest.raises(cli.ApiError) as excinfo:
        api.create_download({"url": VIDEO, "mode": "audio", "format_id": "137+140"})
    assert excinfo.value.code == "format_mode_conflict"
    assert excinfo.value.detail["mode"] == "audio"


def test_the_ws_base_is_derived_from_the_http_base() -> None:
    assert cli.Client("http://127.0.0.1:8765").ws_base == "ws://127.0.0.1:8765"
    assert cli.Client("https://example.test/").ws_base == "wss://example.test"


# --- commands ---------------------------------------------------------------


def test_health_command_prints_the_capabilities(
    api: cli.Client, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(api, ["health"]) == 0
    output = capsys.readouterr().out
    assert "ffmpeg" in output
    assert "bundled" in output
    assert "quickjs-ng" in output


def test_formats_command_renders_a_table(
    api: cli.Client, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(api, ["formats", VIDEO]) == 0
    output = capsys.readouterr().out
    assert "Fake Video" in output
    assert "137" in output and "1920x1080" in output


def test_info_command_summarises(api: cli.Client, capsys: pytest.CaptureFixture[str]) -> None:
    assert run(api, ["info", VIDEO]) == 0
    output = capsys.readouterr().out
    assert "Fake Video" in output
    assert "2024-01-15" in output


def test_json_output_is_available_everywhere(
    api: cli.Client, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(api, ["--json", "info", VIDEO]) == 0
    assert '"id": "abc123XYZ_"' in capsys.readouterr().out


def test_download_command_queues_without_watching(
    api: cli.Client, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run(api, ["download", VIDEO, "--no-watch"]) == 0
    output = capsys.readouterr().out
    assert "queued" in output
    job_id = client.get("/api/v1/downloads").json()["jobs"][0]["job_id"]
    assert job_id in output
    wait_for(client, job_id)


def test_download_command_sends_intent_not_internals(
    api: cli.Client, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    run(api, ["--json", "download", VIDEO, "--mode", "audio", "--audio-format", "mp3", "--no-watch"])
    capsys.readouterr()
    job = client.get("/api/v1/downloads").json()["jobs"][0]
    assert job["options"]["requested"]["mode"] == "audio"
    assert job["options"]["format"] == "bestaudio/best"


def test_jobs_and_cancel_commands(
    api: cli.Client, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    job = api.create_download({"url": "https://fake.test/slow"})
    wait_for(client, job["job_id"], statuses={"downloading"}, timeout=10)

    assert run(api, ["jobs"]) == 0
    assert job["job_id"] in capsys.readouterr().out

    assert run(api, ["cancel", job["job_id"]]) == 0
    assert "cancelled" in capsys.readouterr().out


def test_get_command_saves_a_file(
    api: cli.Client, client: TestClient, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    job = api.create_download({"url": VIDEO})
    finished = wait_for(client, job["job_id"])
    name = next(f["name"] for f in finished["files"] if f["name"].endswith(".mp4"))

    assert run(api, ["get", job["job_id"], name, "-o", str(tmp_path)]) == 0
    assert "saved" in capsys.readouterr().out
    assert (tmp_path / name).is_file()


def test_rm_command_deletes(
    api: cli.Client, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    job = api.create_download({"url": VIDEO})
    wait_for(client, job["job_id"])
    assert run(api, ["rm", job["job_id"]]) == 0
    assert "deleted" in capsys.readouterr().out
    assert api.jobs()["total"] == 0


# --- rendering helpers ------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, "-"), (0, "-"), (512, "512.0 B"), (2048, "2.0 KiB"), (5_242_880, "5.0 MiB")],
)
def test_human_bytes(value: Any, expected: str) -> None:
    assert cli._human_bytes(value) == expected


# --- the three stages -------------------------------------------------------

VIDEO_BYTES = 45_000_000
AUDIO_BYTES = 3_400_000


def drive_a_merge() -> tuple[cli.DownloadProgress, list[float | None]]:
    """Replay the exact event sequence a video+audio merge produces."""
    progress = cli.DownloadProgress()
    progress.on_job({"options": {"merging": True}})
    progress.on_status("downloading")
    readings: list[float | None] = []

    for got in (10_000_000, 30_000_000, VIDEO_BYTES):
        progress.on_progress(
            {"format_id": "137", "downloaded_bytes": got, "total_bytes": VIDEO_BYTES}
        )
        readings.append(progress.percent)
    progress.on_finished({"format_id": "137", "downloaded_bytes": VIDEO_BYTES})
    readings.append(progress.percent)

    # The audio pass starts again at zero. This is what refilled the bar.
    for got in (500_000, 2_000_000, AUDIO_BYTES):
        progress.on_progress(
            {"format_id": "140", "downloaded_bytes": got, "total_bytes": AUDIO_BYTES}
        )
        readings.append(progress.percent)
    progress.on_finished({"format_id": "140", "downloaded_bytes": AUDIO_BYTES})
    readings.append(progress.percent)
    return progress, readings


def test_the_bar_never_goes_backwards_on_a_merge() -> None:
    """The reported bug. yt-dlp reports percent per stream, so the bar first ran
    0->100 twice; byte-weighting then still dropped it ~40 points when the audio
    stream turned out to be a third of the job."""
    _, readings = drive_a_merge()
    assert all(value is not None for value in readings)
    assert readings == sorted(readings), f"bar moved backwards: {readings}"


def test_the_bar_never_reads_complete_while_bytes_are_still_moving() -> None:
    _, readings = drive_a_merge()
    assert all(value is not None and value < 100 for value in readings), readings


def test_each_expected_stream_owns_an_equal_slice() -> None:
    """With a merge, video fills the first half and audio fills the second."""
    progress, readings = drive_a_merge()
    # The video stream alone can never push past its own half of the bar.
    assert readings[2] == pytest.approx(50.0, abs=0.1)
    assert readings[3] == pytest.approx(50.0, abs=0.1)
    # The audio stream then works through the second half.
    assert readings[4] > 50.0
    assert readings[-1] == pytest.approx(99.9, abs=0.1)


def test_a_huge_late_audio_stream_does_not_disturb_the_bar() -> None:
    """The real-world case that broke byte-weighting: a 15 MB video followed by
    10 MB of audio, where the true total is only knowable far too late."""
    progress = cli.DownloadProgress()
    progress.on_job({"options": {"merging": True}})
    progress.on_status("downloading")
    readings = []
    for got in (5_000_000, 15_298_808):
        progress.on_progress(
            {"format_id": "396", "downloaded_bytes": got, "total_bytes": 15_298_808}
        )
        readings.append(progress.percent)
    progress.on_finished({"format_id": "396", "downloaded_bytes": 15_298_808})
    readings.append(progress.percent)
    for got in (1_024, 5_000_000, 10_202_210):
        progress.on_progress(
            {"format_id": "251", "downloaded_bytes": got, "total_bytes": 10_202_210}
        )
        readings.append(progress.percent)

    assert readings == sorted(readings), f"bar moved backwards: {readings}"
    assert readings[2] == pytest.approx(50.0, abs=0.1)
    assert readings[3] >= 50.0


def test_bytes_are_still_summed_for_the_detail_line() -> None:
    progress, _ = drive_a_merge()
    assert progress.downloaded == VIDEO_BYTES + AUDIO_BYTES
    assert progress.total == VIDEO_BYTES + AUDIO_BYTES
    assert progress.stream_count == 2


def test_a_single_stream_download_uses_the_whole_bar() -> None:
    progress = cli.DownloadProgress()
    progress.on_job({"options": {"merging": False}})
    progress.on_status("downloading")
    progress.on_progress({"format_id": "18", "downloaded_bytes": 500, "total_bytes": 1000})
    assert progress.percent == pytest.approx(50.0)
    assert progress.expected_streams == 1


def test_an_unexpected_extra_stream_freezes_rather_than_rewinds() -> None:
    """If the options said one stream but two arrive, the bar holds still until
    the recomputed share catches up. Never backwards."""
    progress = cli.DownloadProgress()
    progress.on_job({"options": {"merging": False}})
    progress.on_status("downloading")
    progress.on_progress({"format_id": "18", "downloaded_bytes": 900, "total_bytes": 1000})
    before = progress.percent
    progress.on_finished({"format_id": "18", "downloaded_bytes": 1000})
    progress.on_progress({"format_id": "140", "downloaded_bytes": 10, "total_bytes": 1000})
    assert progress.expected_streams == 2
    assert progress.percent is not None and before is not None
    assert progress.percent >= before


@pytest.mark.parametrize(
    ("status", "stage", "index"),
    [
        ("queued", "preparing", 1),
        ("extracting", "preparing", 1),
        ("downloading", "downloading", 2),
        ("postprocessing", "processing", 3),
    ],
)
def test_statuses_collapse_into_three_stages(status: str, stage: str, index: int) -> None:
    progress = cli.DownloadProgress()
    progress.on_status(status)
    assert progress.stage == stage
    assert progress.stage_index == index
    assert f"{index}/3 {stage}" in progress.render()


@pytest.mark.parametrize("status", ["queued", "extracting", "postprocessing"])
def test_stages_without_a_measurable_total_are_indeterminate(status: str) -> None:
    """Extraction has no total and ffmpeg reports no percentage, so neither
    stage invents one."""
    progress = cli.DownloadProgress()
    progress.on_status(status)
    assert progress.percent is None
    assert "%" not in progress.render()


def test_postprocessing_does_not_inherit_the_download_percentage() -> None:
    progress, _ = drive_a_merge()
    progress.on_status("postprocessing")
    progress.on_postprocessor({"postprocessor": "FFmpegMerger", "status": "started"})
    assert progress.percent is None
    assert "FFmpegMerger" in progress.render()


def test_a_completed_job_reads_one_hundred() -> None:
    progress, _ = drive_a_merge()
    progress.on_status("completed")
    assert progress.percent == 100.0
    assert "100.0%" in progress.render()


def test_a_failed_job_stalls_the_bar_instead_of_spinning() -> None:
    progress = cli.DownloadProgress()
    progress.on_status("downloading")
    progress.on_progress({"format_id": "137", "downloaded_bytes": 250, "total_bytes": 1000})
    progress.on_status("failed")
    assert progress.percent is None
    assert "25.0%" in progress.render()


def test_a_retried_fragment_does_not_walk_the_bar_backwards() -> None:
    progress = cli.DownloadProgress()
    progress.on_status("downloading")
    progress.on_progress({"format_id": "137", "downloaded_bytes": 800, "total_bytes": 1000})
    progress.on_progress({"format_id": "137", "downloaded_bytes": 300, "total_bytes": 1000})
    assert progress.percent == pytest.approx(80.0)


def test_an_unknown_total_stays_indeterminate_rather_than_guessing() -> None:
    progress = cli.DownloadProgress()
    progress.on_status("downloading")
    progress.on_progress({"format_id": "137", "downloaded_bytes": 1234})
    assert progress.percent is None


def test_an_estimated_total_is_used_when_there_is_no_exact_one() -> None:
    progress = cli.DownloadProgress()
    progress.on_status("downloading")
    progress.on_progress(
        {"format_id": "137", "downloaded_bytes": 250, "total_bytes_estimate": 1000}
    )
    assert progress.percent == pytest.approx(25.0)


def test_the_tracker_survives_a_real_merge_event_stream(client: TestClient) -> None:
    """The unit tests above use hand-written ticks. This one drives the tracker
    with the actual frames the server emits for a video+audio merge."""
    response = client.post("/api/v1/downloads", json={"url": VIDEO})
    job_id = response.json()["job_id"]

    progress = cli.DownloadProgress()
    status_events = {"job.queued", "job.extracting", "job.downloading", "job.postprocessing"}
    terminal = {"job.completed", "job.failed", "job.cancelled"}
    readings: list[float | None] = []
    stages: list[str] = []

    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        for _ in range(600):
            frame = socket.receive_json()
            kind, data = frame["type"], frame["data"]
            if kind == "job.snapshot":
                # The snapshot is the job's state *now*, and the ?since=0 replay
                # that follows re-runs the history from the beginning. Feeding
                # both would report the stage the job had already reached before
                # the socket opened, so the transitions come from the replay.
                continue
            if kind in status_events or kind in terminal:
                progress.on_status(data.get("status"))
            elif kind == "progress":
                progress.on_progress(data)
                readings.append(progress.percent)
            elif kind == "progress.finished":
                progress.on_finished(data)
            elif kind == "postprocessor":
                progress.on_postprocessor(data)
            if stages[-1:] != [progress.stage]:
                stages.append(progress.stage)
            if kind in terminal:
                break

    assert stages == ["preparing", "downloading", "processing", "done"]
    assert progress.stream_count == 2, "expected a video+audio merge"
    assert all(value is not None and value < 100 for value in readings)
    # The bug was the second half of this list restarting near zero.
    assert min(readings[len(readings) // 2 :]) > 50  # type: ignore[type-var]
    assert progress.percent == 100.0


def test_the_download_line_shows_aggregate_bytes_and_rate() -> None:
    progress = cli.DownloadProgress()
    progress.on_status("downloading")
    progress.on_progress(
        {
            "format_id": "137",
            "downloaded_bytes": 1024,
            "total_bytes": 2048,
            "speed": 512.0,
            "eta": 3,
        }
    )
    line = progress.render()
    assert "50.0%" in line
    assert "1.0 KiB/2.0 KiB" in line
    assert "512.0 B/s" in line
    assert "eta 3s" in line
    assert "format 137" in line


# --- the parser -------------------------------------------------------------


def test_every_documented_command_parses() -> None:
    parser = cli.build_parser()
    for argv in (
        ["health"],
        ["info", VIDEO, "--playlist"],
        ["formats", VIDEO],
        ["subtitles", VIDEO],
        ["download", VIDEO, "--mode", "audio", "--audio-format", "opus", "--audio-quality", "256"],
        ["download", VIDEO, "--quality", "720p", "--container", "mp4", "--rate-limit", "500000"],
        ["download", VIDEO, "--subtitles", "en", "es", "--embed-subtitles"],
        ["jobs", "--status", "completed", "--limit", "5"],
        ["job", "abc"],
        ["cancel", "abc"],
        ["rm", "abc", "--keep-files"],
        ["get", "abc", "file.mp4", "-o", "."],
        ["watch"],
        ["watch", "abc"],
    ):
        assert parser.parse_args(argv).fn is not None


def test_bad_choices_are_rejected_before_a_request() -> None:
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["download", VIDEO, "--quality", "1081p"])
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["download", VIDEO, "--mode", "sound"])
