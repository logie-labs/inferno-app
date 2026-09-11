"""The event bus: envelope, sequencing, replay, and the thread bridge (SPEC §5).

Three promises live in this module and nowhere else.

**One envelope.** Every websocket frame, without exception, is
``{type, job_id, ts, seq, data}``. New events add ``type`` values; they never
introduce a new frame shape.

**Lossless streams.** ``seq`` is monotonic per server. A client reconnects with
``?since=<seq>`` and misses nothing. When the ring buffer has already discarded
something the client asked for, the first frame says so via
``data.replay_truncated`` rather than silently skipping events.

**One thread crossing.** yt-dlp is blocking and reports progress on its own
worker thread; websocket clients live on the asyncio event loop. That boundary
is crossed here, via ``loop.call_soon_threadsafe``, and no other module should
think about threads.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

__all__ = [
    "EventType",
    "Event",
    "EventBus",
    "Subscription",
    "FIREHOSE",
    "job_channel",
]

#: The firehose channel, carrying every event across all jobs.
FIREHOSE = "*"


def job_channel(job_id: str) -> str:
    return f"job:{job_id}"


class EventType:
    """Every ``type`` value the server emits (SPEC §5)."""

    JOB_SNAPSHOT = "job.snapshot"
    HELLO = "hello"
    JOB_QUEUED = "job.queued"
    JOB_EXTRACTING = "job.extracting"
    JOB_DOWNLOADING = "job.downloading"
    JOB_POSTPROCESSING = "job.postprocessing"
    PROGRESS = "progress"
    PROGRESS_FINISHED = "progress.finished"
    POSTPROCESSOR = "postprocessor"
    LOG = "log"
    JOB_COMPLETED = "job.completed"
    JOB_FAILED = "job.failed"
    JOB_CANCELLED = "job.cancelled"
    HEARTBEAT = "heartbeat"
    PONG = "pong"
    #: Settings changed. Every connected client converges without polling.
    SETTINGS_CHANGED = "settings.changed"
    #: Something in the download folder is not what it was.
    #:
    #: Carries ``paths``: the directories affected, relative to the download
    #: root, so a client showing one of them knows to re-read and a client
    #: showing another knows it need not. Deliberately not the change itself -
    #: a listing is one cheap request, and an event that tried to describe the
    #: change would have to stay correct about renames, merges and partials,
    #: which is a second source of truth to keep in step with the first.
    #:
    #: Published where the service knows it has altered the folder - a job
    #: publishing its files, and the three write routes - and nowhere else.
    #: Nothing watches the filesystem: a change made by something other than
    #: this service is found when a client next looks, which is the same
    #: guarantee a poll would give without the cost of one.
    FILES_CHANGED = "files.changed"


#: Frames generated per-socket rather than broadcast. They carry the bus's
#: current ``seq`` without advancing it, so a client that reconnects with the
#: ``seq`` from a heartbeat asks for exactly the right position in the stream.
PER_SOCKET_TYPES = frozenset(
    {EventType.JOB_SNAPSHOT, EventType.HELLO, EventType.HEARTBEAT, EventType.PONG}
)


@dataclass(frozen=True)
class Event:
    """One frame. The shape is fixed; only ``type`` and ``data`` vary."""

    type: str
    job_id: str | None
    ts: float
    seq: int
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "job_id": self.job_id,
            "ts": self.ts,
            "seq": self.seq,
            "data": self.data,
        }


@dataclass
class _Channel:
    """A ring buffer plus the bookkeeping that makes truncation detectable."""

    maxlen: int
    buffer: deque[Event] = field(default_factory=deque)
    #: The seq of the most recently evicted event, or None if nothing was lost.
    last_dropped_seq: int | None = None
    subscribers: set["Subscription"] = field(default_factory=set)

    def append(self, event: Event) -> None:
        while len(self.buffer) >= self.maxlen:
            self.last_dropped_seq = self.buffer.popleft().seq
        self.buffer.append(event)

    def replay(self, since: int | None) -> tuple[list[Event], bool]:
        """Return buffered events newer than ``since`` and whether any were lost.

        ``seq`` is global, so a job channel's sequence numbers are naturally
        non-contiguous. Truncation therefore cannot be inferred from gaps; it is
        decided by what this channel actually evicted.
        """
        if since is None:
            return [], False
        pending = [event for event in self.buffer if event.seq > since]
        truncated = self.last_dropped_seq is not None and since < self.last_dropped_seq
        return pending, truncated


class Subscription:
    """One websocket's view of a channel."""

    def __init__(self, channel: str, maxsize: int) -> None:
        self.channel = channel
        self.queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=maxsize)
        self.replay: list[Event] = []
        self.replay_truncated = False
        self.dropped = 0
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        self._closed = True

    def offer(self, event: Event) -> None:
        """Hand one event to this socket without ever blocking the publisher.

        A client that falls far enough behind to overflow its queue should
        reconnect with ``?since=`` and let the replay buffer catch it up.
        """
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:  # pragma: no cover - racing is benign
                pass
            try:
                self.queue.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover - racing is benign
                self.dropped += 1

    async def get(self, timeout: float | None = None) -> Event | None:
        """Next event, or ``None`` when ``timeout`` elapses (time for a heartbeat)."""
        if timeout is None:
            return await self.queue.get()
        try:
            return await asyncio.wait_for(self.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None


class EventBus:
    """Sequences events, buffers them per channel, and fans them out.

    Every job event lands on two channels — the job's own channel and the
    firehose — carrying the same ``seq``, because ``seq`` is monotonic per
    server rather than per channel.
    """

    def __init__(
        self,
        history: int = 250,
        progress_interval: float = 0.25,
        *,
        queue_maxsize: int | None = None,
    ) -> None:
        self._history = max(1, history)
        self._progress_interval = max(0.0, progress_interval)
        self._queue_maxsize = queue_maxsize if queue_maxsize is not None else max(64, self._history * 4)
        self._seq = 0
        self._channels: dict[str, _Channel] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self._throttle: dict[tuple[str, str | None], float] = {}
        self._clock: Callable[[], float] = time.time

    # --- lifecycle ---------------------------------------------------------

    def bind_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        """Remember the event loop that owns the websocket clients."""
        self._loop = loop

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        return self._loop

    @property
    def current_seq(self) -> int:
        return self._seq

    @property
    def subscriber_count(self) -> int:
        return sum(len(channel.subscribers) for channel in self._channels.values())

    def set_clock(self, clock: Callable[[], float]) -> None:
        """Override the clock. Tests use this to drive throttling deterministically."""
        self._clock = clock

    def set_progress_interval(self, interval: float) -> None:
        """Retune progress throttling live, when the setting changes."""
        self._progress_interval = max(0.0, interval)

    # --- the one thread crossing ------------------------------------------

    def run_on_loop(self, fn: Callable[[], Any]) -> None:
        """Run ``fn`` on the event loop, from any thread.

        This is the single place the yt-dlp worker thread reaches the asyncio
        world (SPEC §3). Job state mutation goes through here too, so that no
        other module has to reason about threads.
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            fn()
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            fn()
        else:
            loop.call_soon_threadsafe(fn)

    # --- publishing --------------------------------------------------------

    def publish(
        self,
        type: str,
        job_id: str | None = None,
        data: dict[str, Any] | None = None,
        *,
        throttle: bool = False,
    ) -> Event | None:
        """Sequence, buffer and fan out one event. Returns ``None`` if throttled."""
        if throttle and not self._should_emit(type, job_id):
            return None

        with self._lock:
            self._seq += 1
            event = Event(type=type, job_id=job_id, ts=self._clock(), seq=self._seq, data=dict(data or {}))
            targets = [self._channel(FIREHOSE)]
            if job_id is not None:
                targets.append(self._channel(job_channel(job_id)))
            for channel in targets:
                channel.append(event)
            subscribers = [sub for channel in targets for sub in channel.subscribers]

        for subscription in subscribers:
            if not subscription.closed:
                subscription.offer(event)
        return event

    def publish_threadsafe(
        self,
        type: str,
        job_id: str | None = None,
        data: dict[str, Any] | None = None,
        *,
        throttle: bool = False,
    ) -> None:
        """Publish from a worker thread. Sequencing happens on the loop."""
        self.run_on_loop(lambda: self.publish(type, job_id, data, throttle=throttle))

    def make_frame(
        self, type: str, job_id: str | None = None, data: dict[str, Any] | None = None
    ) -> Event:
        """Build a per-socket frame (hello, snapshot, heartbeat, pong).

        It carries the current ``seq`` without advancing it and is not buffered,
        so reconnecting with that ``seq`` resumes from exactly the right place.
        """
        return Event(type=type, job_id=job_id, ts=self._clock(), seq=self._seq, data=dict(data or {}))

    def _should_emit(self, type: str, job_id: str | None) -> bool:
        if self._progress_interval <= 0:
            return True
        key = (type, job_id)
        now = self._clock()
        last = self._throttle.get(key)
        if last is not None and (now - last) < self._progress_interval:
            return False
        self._throttle[key] = now
        return True

    def reset_throttle(self, job_id: str | None = None) -> None:
        """Forget throttle state, so the next tick of a new phase is not swallowed."""
        if job_id is None:
            self._throttle.clear()
            return
        for key in [k for k in self._throttle if k[1] == job_id]:
            self._throttle.pop(key, None)

    # --- subscribing -------------------------------------------------------

    def _channel(self, name: str) -> _Channel:
        channel = self._channels.get(name)
        if channel is None:
            channel = _Channel(maxlen=self._history)
            self._channels[name] = channel
        return channel

    def subscribe(self, channel: str, since: int | None = None) -> Subscription:
        """Attach to ``channel``, capturing anything newer than ``since``."""
        subscription = Subscription(channel, self._queue_maxsize)
        with self._lock:
            target = self._channel(channel)
            subscription.replay, subscription.replay_truncated = target.replay(since)
            target.subscribers.add(subscription)
        return subscription

    def unsubscribe(self, subscription: Subscription) -> None:
        subscription.close()
        with self._lock:
            channel = self._channels.get(subscription.channel)
            if channel is not None:
                channel.subscribers.discard(subscription)

    def buffered(self, channel: str = FIREHOSE) -> list[Event]:
        """The channel's retained events. Used by ``hello`` and by tests."""
        with self._lock:
            return list(self._channel(channel).buffer)

    def last_dropped_seq(self, channel: str = FIREHOSE) -> int | None:
        with self._lock:
            return self._channel(channel).last_dropped_seq

    def drop_channel(self, channel: str) -> None:
        """Forget a channel entirely. Called when a job is deleted."""
        with self._lock:
            existing = self._channels.pop(channel, None)
        if existing is not None:
            for subscription in list(existing.subscribers):
                subscription.close()

    def iter_channels(self) -> Iterable[str]:
        return tuple(self._channels)
