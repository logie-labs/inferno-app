"""Remembering the finished queue across a restart (``STATE_FILE``).

Off unless a path is configured, which is what keeps the desktop as SPEC §2
describes it - jobs in memory, gone with the process. A server needs the
opposite, because browser tabs outlive it.

Only terminal jobs are written. An interrupted download cannot be resumed from
a file, so recording one would restore a job that says "downloading" and never
moves again.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from inferno_service.binaries import BinaryResolver
from inferno_service.config import Settings
from inferno_service.events import EventBus
from inferno_service.jobs import Job, JobManager, JobStatus
from inferno_service.options import Resolution


def _manager(settings: Settings) -> JobManager:
    return JobManager(settings, BinaryResolver(settings), EventBus(history=10))


def _finished_job(tmp_path: Path, job_id: str = "abc123", *, status: str = JobStatus.COMPLETED) -> Job:
    """A job as it looks once it has finished, with a file that exists."""
    target = tmp_path / "downloads" / "video.mkv"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"not really a video")

    return Job(
        job_id=job_id,
        url="https://example.com/watch?v=1",
        directory=tmp_path / "downloads",
        resolution=Resolution(summary={"mode": "video"}, ydl_opts={}),
        published=[target],
        status=status,
        video={"title": "A video", "automatic_captions": {"en": [{"url": "x"}]}},
        files=[{"name": "video.mkv", "path": str(target), "size": 18}],
        finished_at=1_000.0,
    )


def test_nothing_is_written_without_a_state_file(settings: Settings) -> None:
    """The default, and what the desktop uses."""
    manager = _manager(settings)
    manager._jobs["abc123"] = _finished_job(settings.download_dir.parent)
    manager._order.append("abc123")
    manager._persist()

    # Nothing to assert a path against - the point is that it does not raise
    # and writes nowhere.
    assert manager._state_file is None


def test_a_finished_job_survives_a_restart(settings: Settings, tmp_path: Path) -> None:
    state = tmp_path / "jobs.json"
    configured = replace(settings, state_file=str(state))

    manager = _manager(configured)
    manager._jobs["abc123"] = _finished_job(tmp_path)
    manager._order.append("abc123")
    manager._persist()

    assert state.is_file()

    # A second manager is what a restart amounts to.
    restored = _manager(configured)
    jobs, total = restored.list()

    assert total == 1
    assert jobs[0].job_id == "abc123"
    assert jobs[0].status == JobStatus.COMPLETED
    assert jobs[0].to_dict()["options"] == {"mode": "video"}
    assert jobs[0].files[0]["name"] == "video.mkv"


def test_automatic_captions_are_not_written(settings: Settings, tmp_path: Path) -> None:
    """The one field dropped: ~460 KB per job, and no client reads it."""
    state = tmp_path / "jobs.json"
    configured = replace(settings, state_file=str(state))

    manager = _manager(configured)
    manager._jobs["abc123"] = _finished_job(tmp_path)
    manager._order.append("abc123")
    manager._persist()

    written = json.loads(state.read_text(encoding="utf-8"))
    video = written["jobs"][0]["video"]

    assert "automatic_captions" not in video
    # Everything the details view actually shows is kept.
    assert video["title"] == "A video"


def test_a_job_whose_files_are_gone_is_forgotten(
    settings: Settings, tmp_path: Path
) -> None:
    """Files are swept on their own schedule; history nobody can act on is not
    worth restoring."""
    state = tmp_path / "jobs.json"
    configured = replace(settings, state_file=str(state))

    manager = _manager(configured)
    job = _finished_job(tmp_path)
    manager._jobs["abc123"] = job
    manager._order.append("abc123")
    manager._persist()

    Path(job.files[0]["path"]).unlink()

    restored = _manager(configured)

    assert restored.list()[1] == 0


def test_a_failed_job_survives_even_with_no_files(
    settings: Settings, tmp_path: Path
) -> None:
    """Only completed jobs are checked for files - a failure has none by
    definition, and is exactly the history worth keeping."""
    state = tmp_path / "jobs.json"
    configured = replace(settings, state_file=str(state))

    manager = _manager(configured)
    job = _finished_job(tmp_path, status=JobStatus.FAILED)
    job.files = []
    job.error = {"code": "video_unavailable", "message": "gone"}
    manager._jobs["abc123"] = job
    manager._order.append("abc123")
    manager._persist()

    restored = _manager(configured)
    jobs, total = restored.list()

    assert total == 1
    assert jobs[0].status == JobStatus.FAILED
    assert jobs[0].error == {"code": "video_unavailable", "message": "gone"}


@pytest.mark.parametrize("body", ["{ not json", "", '{"jobs": [{"bad": 1}]}'])
def test_an_unreadable_state_file_does_not_stop_the_service(
    settings: Settings, tmp_path: Path, body: str
) -> None:
    """Losing history is a far smaller problem than refusing to start."""
    state = tmp_path / "jobs.json"
    state.write_text(body, encoding="utf-8")
    configured = replace(settings, state_file=str(state))

    manager = _manager(configured)

    assert manager.list()[1] == 0
