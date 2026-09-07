"""SPEC §5: one envelope, monotonic seq, lossless replay, heartbeats, ping/pong."""

from __future__ import annotations

from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service import main as main_module
from inferno_service.config import Settings
from inferno_service.events import EventBus
from inferno_service.jobs import _JobLogger

from .conftest import wait_for

VIDEO = "https://fake.test/video"
SLOW = "https://fake.test/slow"
ENVELOPE_KEYS = {"type", "job_id", "ts", "seq", "data"}
TERMINAL = {"job.completed", "job.failed", "job.cancelled"}


def queue(client: TestClient, url: str = VIDEO, **body: Any) -> str:
    response = client.post("/api/v1/downloads", json={"url": url, **body})
    assert response.status_code == 202, response.text
    return response.json()["job_id"]


def drain(socket: Any, until: set[str], limit: int = 400) -> list[dict[str, Any]]:
    """Read frames until one of ``until`` arrives."""
    frames: list[dict[str, Any]] = []
    for _ in range(limit):
        frame = socket.receive_json()
        frames.append(frame)
        if frame["type"] in until:
            return frames
    raise AssertionError(f"never saw any of {sorted(until)}; got {[f['type'] for f in frames]}")


# --- the envelope -----------------------------------------------------------


def test_the_first_frame_on_a_job_socket_is_a_snapshot(client: TestClient) -> None:
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}") as socket:
        frame = socket.receive_json()
        assert set(frame) == ENVELOPE_KEYS
        assert frame["type"] == "job.snapshot"
        assert frame["job_id"] == job_id
        assert frame["data"]["job"]["job_id"] == job_id
        assert frame["data"]["job"]["options"]["format"]
        assert frame["data"]["replay_truncated"] is False


def test_the_first_frame_on_the_firehose_is_hello(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        frame = socket.receive_json()
        assert set(frame) == ENVELOPE_KEYS
        assert frame["type"] == "hello"
        assert frame["job_id"] is None
        assert frame["data"]["service"] == "inferno-service"
        assert frame["data"]["product"] == "inferno"
        assert frame["data"]["version"]
        assert frame["data"]["capabilities"]["ffmpeg"]["source"] == "bundled"
        assert frame["data"]["jobs"] == []


def test_hello_lists_recent_jobs(client: TestClient) -> None:
    job_id = queue(client)
    wait_for(client, job_id)
    with client.websocket_connect("/ws/events") as socket:
        frame = socket.receive_json()
        assert [job["job_id"] for job in frame["data"]["jobs"]] == [job_id]


def test_every_frame_shares_one_shape(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        job_id = queue(client)
        frames = drain(socket, TERMINAL)
        assert frames, "expected events"
        for frame in frames:
            assert set(frame) == ENVELOPE_KEYS, frame
            assert isinstance(frame["seq"], int)
            assert isinstance(frame["ts"], float)
            assert isinstance(frame["data"], dict)
        assert {f["job_id"] for f in frames} == {job_id}


def test_seq_is_monotonic_across_the_stream(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        queue(client)
        frames = drain(socket, TERMINAL)
        seqs = [frame["seq"] for frame in frames]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)


# --- lifecycle events -------------------------------------------------------


def test_a_job_socket_reports_the_whole_lifecycle(client: TestClient) -> None:
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        assert socket.receive_json()["type"] == "job.snapshot"
        frames = drain(socket, TERMINAL)
        types = [frame["type"] for frame in frames]

    assert "job.extracting" in types
    assert "job.downloading" in types
    assert "job.postprocessing" in types
    assert "progress" in types
    assert types[-1] == "job.completed"


def test_progress_finished_fires_once_per_stream_on_a_merge(client: TestClient) -> None:
    """SPEC §5: it fires twice for a video+audio merge, and clients tell the
    passes apart by format_id."""
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        frames = drain(socket, TERMINAL)

    finished = [f for f in frames if f["type"] == "progress.finished"]
    assert len(finished) == 2
    assert {f["data"]["format_id"] for f in finished} == {"137", "140"}


def test_percent_restarts_between_streams(client: TestClient) -> None:
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        frames = drain(socket, TERMINAL)

    by_format: dict[str, list[float]] = {}
    for frame in frames:
        if frame["type"] == "progress":
            data = frame["data"]
            by_format.setdefault(data["format_id"], []).append(data["percent"])

    assert set(by_format) == {"137", "140"}
    for percents in by_format.values():
        assert percents == sorted(percents)
        assert percents[0] < 100


def test_progress_says_which_stream_it_is_about(client: TestClient) -> None:
    # A client drawing one bar per stream has to label them. Arrival order is
    # a yt-dlp detail; the codecs are the actual answer.
    with client.websocket_connect("/ws/events") as socket:
        job_id = client.post("/api/v1/downloads", json={"url": VIDEO}).json()["job_id"]
        seen: list[dict[str, Any]] = []
        for _ in range(200):
            frame = socket.receive_json()
            if frame["type"] in ("progress", "progress.finished"):
                seen.append(frame["data"])
            if frame["type"] == "job.completed":
                break

    assert seen, "no progress frames arrived"
    for data in seen:
        assert "vcodec" in data and "acodec" in data
    # At least one frame identifies a stream that carries video.
    assert any(
        (data.get("vcodec") or "none") != "none" for data in seen
    ), "no frame identified a video stream"


def test_the_completed_event_carries_the_files(client: TestClient) -> None:
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        frames = drain(socket, TERMINAL)

    completed = frames[-1]
    assert completed["type"] == "job.completed"
    assert completed["data"]["files"]
    assert completed["data"]["elapsed"] is not None


def test_a_failure_event_carries_the_code(client: TestClient) -> None:
    job_id = queue(client, url="https://fake.test/unavailable")
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        frames = drain(socket, TERMINAL)

    assert frames[-1]["type"] == "job.failed"
    assert frames[-1]["data"]["error"]["code"] == "video_unavailable"


def test_cancellation_produces_a_terminal_event(client: TestClient) -> None:
    job_id = queue(client, url=SLOW)
    with client.websocket_connect(f"/ws/downloads/{job_id}") as socket:
        socket.receive_json()
        wait_for(client, job_id, statuses={"downloading"}, timeout=10)
        client.post(f"/api/v1/downloads/{job_id}/cancel")
        frames = drain(socket, TERMINAL)

    assert frames[-1]["type"] == "job.cancelled"


def test_yt_dlp_output_becomes_log_events(bus: EventBus) -> None:
    """The logger handed to yt-dlp routes its output onto the bus with a level."""
    logger = _JobLogger(bus, "job1")
    logger.warning("Falling back to a worse format")
    logger.error("boom")
    logger.debug("[debug] verbose noise")
    logger.debug("plain stdout line")
    logger.info("   ")  # blank output is not worth a frame

    logs = [event for event in bus.buffered() if event.type == "log"]
    assert [(event.data["level"], event.data["message"]) for event in logs] == [
        ("warning", "Falling back to a worse format"),
        ("error", "boom"),
        ("debug", "[debug] verbose noise"),
        ("info", "plain stdout line"),
    ]


def test_log_events_reach_a_job_socket(client: TestClient) -> None:
    job_id = queue(client)
    events = client.app.state.ctx.events
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        events.publish("log", job_id, {"level": "warning", "message": "hi"})
        frames = drain(socket, {"log"})

    assert frames[-1]["data"] == {"level": "warning", "message": "hi"}
    assert frames[-1]["job_id"] == job_id


# --- replay -----------------------------------------------------------------


def test_reconnecting_with_since_replays_what_was_missed(client: TestClient) -> None:
    job_id = queue(client)
    wait_for(client, job_id)

    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()  # snapshot
        replayed = drain(socket, TERMINAL)

    assert [f["type"] for f in replayed][-1] == "job.completed"
    assert any(f["type"] == "job.queued" for f in replayed)


def test_since_skips_everything_already_seen(client: TestClient) -> None:
    job_id = queue(client)
    wait_for(client, job_id)
    events = client.app.state.ctx.events
    latest = events.current_seq

    with client.websocket_connect(f"/ws/downloads/{job_id}?since={latest}") as socket:
        assert socket.receive_json()["type"] == "job.snapshot"
        events.publish("log", job_id, {"level": "info", "message": "after"})
        frame = socket.receive_json()
        assert frame["type"] == "log"
        assert frame["seq"] == latest + 1


def test_a_truncated_replay_says_so_in_the_first_frame(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    """SPEC §5: say so rather than silently skipping events."""
    client = make_client(settings.replace(event_history=5))
    job_id = queue(client)
    wait_for(client, job_id)

    with client.websocket_connect(f"/ws/downloads/{job_id}?since=1") as socket:
        first = socket.receive_json()
        assert first["type"] == "job.snapshot"
        assert first["data"]["replay_truncated"] is True

    with client.websocket_connect("/ws/events?since=1") as socket:
        first = socket.receive_json()
        assert first["type"] == "hello"
        assert first["data"]["replay_truncated"] is True


def test_an_intact_replay_is_not_flagged(client: TestClient) -> None:
    job_id = queue(client)
    wait_for(client, job_id)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        assert socket.receive_json()["data"]["replay_truncated"] is False


def test_a_nonsense_since_is_ignored_rather_than_fatal(client: TestClient) -> None:
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=banana") as socket:
        assert socket.receive_json()["type"] == "job.snapshot"


# --- client to server -------------------------------------------------------


def test_ping_is_answered_with_pong(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        socket.send_json({"type": "ping"})
        frame = socket.receive_json()
        assert frame["type"] == "pong"
        assert set(frame) == ENVELOPE_KEYS


def test_pong_does_not_advance_seq(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        hello = socket.receive_json()
        socket.send_json({"type": "ping"})
        assert socket.receive_json()["seq"] == hello["seq"]


def test_unknown_client_messages_are_ignored(client: TestClient) -> None:
    """REST is the canonical path for actions; the socket takes ping and nothing else."""
    job_id = queue(client)
    with client.websocket_connect(f"/ws/downloads/{job_id}?since=0") as socket:
        socket.receive_json()
        socket.send_json({"type": "cancel", "job_id": job_id})
        frames = drain(socket, TERMINAL)

    assert frames[-1]["type"] == "job.completed"
    assert client.get(f"/api/v1/downloads/{job_id}").json()["status"] == "completed"


# --- heartbeats and lifetime ------------------------------------------------


def test_an_idle_socket_gets_a_heartbeat(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main_module, "HEARTBEAT_INTERVAL", 0.1)
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        frame = socket.receive_json()
        assert frame["type"] == "heartbeat"
        assert set(frame) == ENVELOPE_KEYS


def test_heartbeats_do_not_advance_seq(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main_module, "HEARTBEAT_INTERVAL", 0.1)
    with client.websocket_connect("/ws/events") as socket:
        hello = socket.receive_json()
        assert socket.receive_json()["seq"] == hello["seq"]


def test_an_unknown_job_socket_is_closed(client: TestClient) -> None:
    with pytest.raises(Exception):
        with client.websocket_connect("/ws/downloads/nope") as socket:
            socket.receive_json()


def test_sockets_are_released_on_disconnect(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        assert client.get("/health").json()["websocket_clients"] == 1
    assert client.get("/health").json()["websocket_clients"] == 0


def test_the_firehose_carries_every_job(client: TestClient) -> None:
    with client.websocket_connect("/ws/events") as socket:
        socket.receive_json()
        first = queue(client)
        second = queue(client)
        wait_for(client, first)
        wait_for(client, second)

        seen: set[str] = set()
        for _ in range(600):
            frame = socket.receive_json()
            if frame["type"] == "job.completed":
                seen.add(frame["job_id"])
                if seen == {first, second}:
                    break
        assert seen == {first, second}
