"""SPEC §5 and §11 step 3: settle the event contract before jobs complicate it.

These tests use synthetic events only — no downloads exist here.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from inferno_service.events import FIREHOSE, EventBus, EventType, job_channel


def test_every_frame_has_the_same_shape(bus: EventBus) -> None:
    event = bus.publish(EventType.PROGRESS, "job1", {"percent": 12.5})
    assert event is not None
    assert set(event.to_dict()) == {"type", "job_id", "ts", "seq", "data"}
    assert event.to_dict()["data"] == {"percent": 12.5}


def test_seq_is_monotonic_per_server_not_per_channel(bus: EventBus) -> None:
    first = bus.publish(EventType.PROGRESS, "a")
    second = bus.publish(EventType.PROGRESS, "b")
    third = bus.publish(EventType.PROGRESS, "a")
    assert [e.seq for e in (first, second, third) if e] == [1, 2, 3]


def test_a_job_event_lands_on_both_channels_with_one_seq(bus: EventBus) -> None:
    event = bus.publish(EventType.JOB_QUEUED, "job1", {"status": "queued"})
    assert event is not None
    firehose = bus.buffered(FIREHOSE)
    job = bus.buffered(job_channel("job1"))
    assert [e.seq for e in firehose] == [event.seq]
    assert [e.seq for e in job] == [event.seq]


def test_events_without_a_job_stay_off_job_channels(bus: EventBus) -> None:
    bus.publish(EventType.HEARTBEAT, None, {})
    assert len(bus.buffered(FIREHOSE)) == 1
    assert bus.buffered(job_channel("job1")) == []


def test_the_buffer_is_bounded_per_channel() -> None:
    bus = EventBus(history=5, progress_interval=0.0)
    for index in range(12):
        bus.publish(EventType.PROGRESS, "job1", {"index": index})
    assert len(bus.buffered(FIREHOSE)) == 5
    assert [e.data["index"] for e in bus.buffered(FIREHOSE)] == [7, 8, 9, 10, 11]


def test_replay_returns_only_events_newer_than_since(bus: EventBus) -> None:
    for index in range(4):
        bus.publish(EventType.PROGRESS, "job1", {"index": index})
    subscription = bus.subscribe(FIREHOSE, since=2)
    assert [e.seq for e in subscription.replay] == [3, 4]
    assert subscription.replay_truncated is False


def test_subscribing_without_since_replays_nothing(bus: EventBus) -> None:
    bus.publish(EventType.PROGRESS, "job1")
    subscription = bus.subscribe(FIREHOSE)
    assert subscription.replay == []
    assert subscription.replay_truncated is False


def test_truncation_is_flagged_when_the_buffer_dropped_what_was_asked_for() -> None:
    bus = EventBus(history=5, progress_interval=0.0)
    for _ in range(10):
        bus.publish(EventType.PROGRESS, "job1")

    # seq 1-5 were evicted; the client that has only seen seq 4 has lost events.
    assert bus.subscribe(FIREHOSE, since=4).replay_truncated is True
    # A client that already has seq 5 has lost nothing: 6-10 are all retained.
    assert bus.subscribe(FIREHOSE, since=5).replay_truncated is False
    assert bus.subscribe(FIREHOSE, since=9).replay_truncated is False


def test_gaps_in_a_job_channel_are_not_mistaken_for_truncation() -> None:
    """seq is global, so a job channel's numbers are naturally non-contiguous.
    That must never be reported as lost events."""
    bus = EventBus(history=5, progress_interval=0.0)
    bus.publish(EventType.PROGRESS, "quiet")  # seq 1
    for _ in range(20):
        bus.publish(EventType.PROGRESS, "noisy")
    bus.publish(EventType.PROGRESS, "quiet")  # seq 22

    subscription = bus.subscribe(job_channel("quiet"), since=1)
    assert subscription.replay_truncated is False
    assert [e.seq for e in subscription.replay] == [22]


def test_progress_throttling_drops_intermediate_ticks() -> None:
    now = [1000.0]
    bus = EventBus(history=50, progress_interval=0.25)
    bus.set_clock(lambda: now[0])

    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is not None
    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is None

    now[0] += 0.3
    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is not None
    # A throttled event never gets a seq, so the stream stays gap-free.
    assert [e.seq for e in bus.buffered(FIREHOSE)] == [1, 2]


def test_throttling_is_per_job() -> None:
    now = [1000.0]
    bus = EventBus(history=50, progress_interval=0.25)
    bus.set_clock(lambda: now[0])
    assert bus.publish(EventType.PROGRESS, "a", throttle=True) is not None
    assert bus.publish(EventType.PROGRESS, "b", throttle=True) is not None


def test_unthrottled_events_are_never_dropped() -> None:
    bus = EventBus(history=50, progress_interval=10.0)
    for _ in range(5):
        assert bus.publish(EventType.JOB_DOWNLOADING, "job1") is not None


def test_reset_throttle_lets_the_next_phase_through() -> None:
    now = [1000.0]
    bus = EventBus(history=50, progress_interval=10.0)
    bus.set_clock(lambda: now[0])
    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is not None
    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is None
    bus.reset_throttle("job1")
    assert bus.publish(EventType.PROGRESS, "job1", throttle=True) is not None


def test_per_socket_frames_do_not_advance_seq(bus: EventBus) -> None:
    bus.publish(EventType.PROGRESS, "job1")
    frame = bus.make_frame(EventType.HEARTBEAT, "job1")
    assert frame.seq == bus.current_seq == 1
    assert set(frame.to_dict()) == {"type", "job_id", "ts", "seq", "data"}
    # It is not buffered either, so a reconnect at that seq resumes correctly.
    assert len(bus.buffered(FIREHOSE)) == 1


def test_subscribers_receive_live_events(bus: EventBus) -> None:
    subscription = bus.subscribe(job_channel("job1"))
    bus.publish(EventType.PROGRESS, "job1", {"percent": 50})
    bus.publish(EventType.PROGRESS, "other", {"percent": 10})
    assert subscription.queue.qsize() == 1
    assert subscription.queue.get_nowait().data == {"percent": 50}


def test_unsubscribe_stops_delivery(bus: EventBus) -> None:
    subscription = bus.subscribe(FIREHOSE)
    bus.unsubscribe(subscription)
    bus.publish(EventType.PROGRESS, "job1")
    assert subscription.queue.qsize() == 0
    assert bus.subscriber_count == 0


def test_a_slow_subscriber_drops_oldest_rather_than_blocking() -> None:
    bus = EventBus(history=100, progress_interval=0.0, queue_maxsize=3)
    subscription = bus.subscribe(FIREHOSE)
    for index in range(6):
        bus.publish(EventType.PROGRESS, "job1", {"index": index})
    assert subscription.queue.qsize() == 3
    assert subscription.dropped == 3
    assert subscription.queue.get_nowait().data["index"] == 3


def test_drop_channel_forgets_a_deleted_job(bus: EventBus) -> None:
    subscription = bus.subscribe(job_channel("job1"))
    bus.publish(EventType.PROGRESS, "job1")
    bus.drop_channel(job_channel("job1"))
    assert bus.buffered(job_channel("job1")) == []
    assert subscription.closed is True


def test_publish_works_with_no_loop_bound(bus: EventBus) -> None:
    """Useful in unit tests, and safe if a hook fires during shutdown."""
    assert bus.loop is None
    assert bus.publish(EventType.LOG, "job1", {"level": "info"}) is not None


async def test_worker_threads_reach_the_loop_through_the_bridge() -> None:
    """SPEC §3: the thread-to-loop boundary is crossed in exactly one place."""
    bus = EventBus(history=10, progress_interval=0.0)
    bus.bind_loop(asyncio.get_running_loop())
    subscription = bus.subscribe(FIREHOSE)

    def worker() -> None:
        for index in range(3):
            bus.publish_threadsafe(EventType.PROGRESS, "job1", {"index": index})

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    received = [await asyncio.wait_for(subscription.queue.get(), timeout=2.0) for _ in range(3)]
    assert [event.data["index"] for event in received] == [0, 1, 2]
    assert [event.seq for event in received] == [1, 2, 3]


async def test_run_on_loop_executes_state_changes_on_the_loop() -> None:
    bus = EventBus(history=10, progress_interval=0.0)
    loop = asyncio.get_running_loop()
    bus.bind_loop(loop)
    observed: list[object] = []

    def worker() -> None:
        bus.run_on_loop(lambda: observed.append(threading.current_thread().ident))

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    for _ in range(50):
        if observed:
            break
        await asyncio.sleep(0.01)

    assert observed == [threading.current_thread().ident]


async def test_get_with_timeout_returns_none_for_a_heartbeat_tick() -> None:
    bus = EventBus(history=10, progress_interval=0.0)
    bus.bind_loop(asyncio.get_running_loop())
    subscription = bus.subscribe(FIREHOSE)
    assert await subscription.get(timeout=0.05) is None


@pytest.mark.parametrize(
    "event_type",
    [
        EventType.JOB_QUEUED,
        EventType.JOB_EXTRACTING,
        EventType.JOB_DOWNLOADING,
        EventType.JOB_POSTPROCESSING,
        EventType.PROGRESS,
        EventType.PROGRESS_FINISHED,
        EventType.POSTPROCESSOR,
        EventType.LOG,
        EventType.JOB_COMPLETED,
        EventType.JOB_FAILED,
        EventType.JOB_CANCELLED,
    ],
)
def test_all_broadcast_types_use_the_one_envelope(bus: EventBus, event_type: str) -> None:
    event = bus.publish(event_type, "job1", {"anything": True})
    assert event is not None
    assert event.to_dict()["type"] == event_type
