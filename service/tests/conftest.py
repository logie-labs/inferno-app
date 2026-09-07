"""Shared fixtures.

Two things make the suite hermetic: every test gets its own :class:`Settings`
pointing at a temp directory, and the binaries are stubbed as files plus a
patched version probe, so nothing here depends on what is installed on the
machine running it.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from inferno_service.binaries import BinaryResolver  # noqa: E402
from inferno_service.config import Settings  # noqa: E402
from inferno_service.events import EventBus  # noqa: E402
from inferno_service.main import create_app  # noqa: E402

from . import fake_ytdlp  # noqa: E402

EXE = ".exe" if os.name == "nt" else ""


def make_binary(directory: Path, stem: str) -> Path:
    """Create a file that looks like an executable to the resolver."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stem}{EXE}"
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o755)
    return path


@pytest.fixture(autouse=True)
def stub_version_probe(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Never execute the stub binaries; return canned version output instead.

    Live tests are exempt. Their whole point is to report the real environment,
    and a stubbed probe would have them print a version no binary on the machine
    actually has.
    """
    if request.node.get_closest_marker("live"):
        return

    from inferno_service import binaries as binaries_module

    def _probe(path: str, args: Any) -> tuple[str | None, str | None]:
        name = Path(path).name.lower()
        if name.startswith("ffmpeg"):
            return "ffmpeg version 7.1 Copyright (c) 2000-2024", None
        if name.startswith("ffprobe"):
            return "ffprobe version 7.1 Copyright (c) 2007-2024", None
        if name.startswith(("qjs", "quickjs")):
            return "quickjs-ng version 0.16.2", None
        return None, "unknown binary"

    monkeypatch.setattr(binaries_module, "_probe_version", _probe)


@pytest.fixture
def vendor_dir(tmp_path: Path) -> Path:
    """A bundled vendor tree with every binary present."""
    root = tmp_path / "vendor"
    make_binary(root / "ffmpeg", "ffmpeg")
    make_binary(root / "ffmpeg", "ffprobe")
    make_binary(root / "js", "qjs")
    return root


@pytest.fixture
def empty_vendor_dir(tmp_path: Path) -> Path:
    """A vendor tree with nothing in it."""
    root = tmp_path / "empty-vendor"
    root.mkdir()
    return root


@pytest.fixture
def isolated_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty PATH, so a resolver cannot accidentally find a real ffmpeg."""
    monkeypatch.setenv("PATH", "")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        download_dir=tmp_path / "downloads",
        max_concurrent=2,
        job_ttl=3600,
        event_history=50,
        progress_interval=0.0,  # no throttling unless a test asks for it
        info_cache_ttl=300,
        api_token=None,
        cors_origins=("*",),
        http_chunk_size=262_144,
        serve_files=True,
    )


@pytest.fixture
def binaries(settings: Settings, vendor_dir: Path, isolated_path: None) -> BinaryResolver:
    return BinaryResolver(settings, vendor_dir=vendor_dir)


@pytest.fixture
def no_ffmpeg(settings: Settings, empty_vendor_dir: Path, isolated_path: None) -> BinaryResolver:
    return BinaryResolver(settings, vendor_dir=empty_vendor_dir)


@pytest.fixture
def bus() -> EventBus:
    return EventBus(history=5, progress_interval=0.0)


@pytest.fixture
def fake_ydl(monkeypatch: pytest.MonkeyPatch) -> type[fake_ytdlp.FakeYoutubeDL]:
    return fake_ytdlp.install(monkeypatch)


@pytest.fixture
def make_client(
    vendor_dir: Path,
    isolated_path: None,
    fake_ydl: type[fake_ytdlp.FakeYoutubeDL],
) -> Callable[..., Any]:
    """Build a TestClient for arbitrary settings, with lifespan running."""
    created: list[TestClient] = []

    def _factory(settings: Settings, *, vendor: Path | None = None) -> TestClient:
        app = create_app(settings, vendor_dir=vendor if vendor is not None else vendor_dir)
        client = TestClient(app)
        client.__enter__()
        created.append(client)
        return client

    try:
        yield _factory  # type: ignore[misc]
    finally:
        for client in created:
            client.__exit__(None, None, None)


@pytest.fixture
def client(make_client: Callable[..., TestClient], settings: Settings) -> TestClient:
    return make_client(settings)


# --- helpers ----------------------------------------------------------------

TERMINAL = {"completed", "failed", "cancelled"}


def wait_for(
    client: TestClient,
    job_id: str,
    statuses: set[str] = TERMINAL,
    timeout: float = 15.0,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Poll a job until it reaches one of ``statuses``. Polling keeps the test
    honest: it only ever looks at the public API."""
    deadline = time.monotonic() + timeout
    job: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/downloads/{job_id}", headers=headers or {})
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in statuses:
            return job
        time.sleep(0.02)
    raise AssertionError(
        f"job {job_id} stayed in {job.get('status')!r}, never reached {sorted(statuses)}"
    )


@pytest.fixture
def wait_for_job() -> Callable[..., dict[str, Any]]:
    return wait_for
