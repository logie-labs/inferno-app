"""The layered settings system: one schema, provenance, live application.

These tests hold the design honest in the three places it can rot: the schema
drifting from the models it describes, a layer winning when it should not, and a
change that claims to apply live but does not.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service.config import (
    DOWNLOAD_SETTINGS,
    SERVICE_SETTINGS,
    SETTINGS,
    SETTINGS_BY_KEY,
    Settings,
    SettingsError,
    SettingsStore,
    coerce,
    emit_typescript,
    resolve_layers,
)
from inferno_service.main import create_app
from inferno_service.options import translate_template
from inferno_service.schemas import DownloadRequest

from .conftest import wait_for

VIDEO = "https://fake.test/video"


@pytest.fixture
def store(tmp_path: Path) -> SettingsStore:
    return SettingsStore(config_file=tmp_path / "settings.json", env={})


@pytest.fixture
def store_client(
    tmp_path: Path, vendor_dir: Path, isolated_path: None, fake_ydl: Any
) -> Callable[..., TestClient]:
    """A client backed by a real, persisting settings store."""
    created: list[TestClient] = []

    def _factory(**env: str) -> TestClient:
        made = SettingsStore(config_file=tmp_path / "settings.json", env=env)
        made.update({"downloads.directory": str(tmp_path / "downloads")})
        client = TestClient(create_app(store=made, vendor_dir=vendor_dir))
        client.__enter__()
        created.append(client)
        return client

    try:
        yield _factory  # type: ignore[misc]
    finally:
        for client in created:
            client.__exit__(None, None, None)


# --- the schema describes the real thing ------------------------------------


def test_every_service_setting_maps_to_a_settings_field() -> None:
    """A schema row that names a field the snapshot does not have would fail
    silently at runtime, so prove the mapping instead."""
    available = set(Settings().__dataclass_fields__)
    for setting in SERVICE_SETTINGS:
        assert setting.field in available, f"{setting.key} -> {setting.field}"


def test_every_download_setting_maps_to_a_request_field() -> None:
    available = set(DownloadRequest.model_fields)
    for setting in DOWNLOAD_SETTINGS:
        assert setting.field in available, f"{setting.key} -> {setting.field}"


def test_download_defaults_agree_with_the_request_model() -> None:
    """The schema's default and the model's default must not disagree, or the
    answer would depend on which path a value took."""
    def model_default(name: str) -> Any:
        info = DownloadRequest.model_fields[name]
        if info.default_factory is not None:
            return info.default_factory()  # type: ignore[call-arg]
        return info.default

    for setting in DOWNLOAD_SETTINGS:
        assert setting.default == model_default(setting.field), setting.key


def test_keys_are_unique_and_namespaced() -> None:
    keys = [s.key for s in SETTINGS]
    assert len(keys) == len(set(keys))
    assert all("." in key for key in keys)


def test_env_names_are_unique() -> None:
    envs = [s.env for s in SETTINGS if s.env]
    assert len(envs) == len(set(envs))


# --- layers and provenance --------------------------------------------------


def test_defaults_win_when_nothing_else_is_set() -> None:
    layers = resolve_layers({}, {})
    assert layers.values["downloads.max_concurrent"] == 2
    assert layers.sources["downloads.max_concurrent"] == "default"


def test_the_file_layer_beats_the_default() -> None:
    layers = resolve_layers({"downloads.max_concurrent": 5}, {})
    assert layers.values["downloads.max_concurrent"] == 5
    assert layers.sources["downloads.max_concurrent"] == "file"


def test_the_env_layer_beats_the_file() -> None:
    layers = resolve_layers({"downloads.max_concurrent": 5}, {"MAX_CONCURRENT": "9"})
    assert layers.values["downloads.max_concurrent"] == 9
    assert layers.sources["downloads.max_concurrent"] == "env"
    assert "downloads.max_concurrent" in layers.env_keys


def test_a_bad_file_value_is_reported_and_skipped() -> None:
    """User-editable state must never stop the service from starting."""
    layers = resolve_layers({"downloads.max_concurrent": "banana"}, {})
    assert layers.values["downloads.max_concurrent"] == 2
    assert layers.sources["downloads.max_concurrent"] == "default"
    assert any("max_concurrent" in error for error in layers.errors)


def test_a_bad_env_value_raises_because_it_is_an_operator_mistake() -> None:
    with pytest.raises(SettingsError, match="MAX_CONCURRENT"):
        resolve_layers({}, {"MAX_CONCURRENT": "banana"})


def test_unknown_keys_in_the_file_are_ignored() -> None:
    layers = resolve_layers({"nonsense.key": 1}, {})
    assert "nonsense.key" not in layers.values


# --- coercion ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("key", "given", "expected"),
    [
        ("downloads.max_concurrent", "4", 4),
        ("server.serve_files", "no", False),
        ("server.serve_files", True, True),
        ("events.progress_interval", "0.5", 0.5),
        ("server.cors_origins", "a.test, b.test", ["a.test", "b.test"]),
        ("server.cors_origins", ["a.test"], ["a.test"]),
        ("media.quality", "1080p", "1080p"),
    ],
)
def test_values_are_coerced_to_their_declared_type(key: str, given: Any, expected: Any) -> None:
    assert coerce(SETTINGS_BY_KEY[key], given) == expected


@pytest.mark.parametrize(
    ("key", "given"),
    [
        ("downloads.max_concurrent", 0),
        ("downloads.max_concurrent", 99),
        ("downloads.max_concurrent", "lots"),
        ("media.quality", "1081p"),
        ("media.mode", "sound"),
        ("server.serve_files", "perhaps"),
    ],
)
def test_out_of_range_and_unknown_values_are_refused(key: str, given: Any) -> None:
    with pytest.raises(SettingsError):
        coerce(SETTINGS_BY_KEY[key], given)


def test_env_values_are_clamped_rather_than_refused() -> None:
    """An operator writing MAX_CONCURRENT=0 gets the nearest legal value, since
    refusing would leave the service unable to start at all."""
    assert coerce(SETTINGS_BY_KEY["downloads.max_concurrent"], "0", from_env=True) == 1
    assert coerce(SETTINGS_BY_KEY["downloads.max_concurrent"], "999", from_env=True) == 16


def test_nullable_settings_accept_none() -> None:
    assert coerce(SETTINGS_BY_KEY["network.proxy"], None) is None
    assert coerce(SETTINGS_BY_KEY["media.container"], None) is None


# --- the store --------------------------------------------------------------


def test_update_changes_the_effective_snapshot(store: SettingsStore) -> None:
    assert store.settings.max_concurrent == 2
    changed = store.update({"downloads.max_concurrent": 6})
    assert changed == {"downloads.max_concurrent"}
    assert store.settings.max_concurrent == 6
    assert store.sources["downloads.max_concurrent"] == "file"


def test_update_persists_atomically_and_reloads(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    SettingsStore(config_file=path, env={}).update({"downloads.max_concurrent": 7})

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["values"]["downloads.max_concurrent"] == 7
    assert not list(tmp_path.glob("*.tmp")), "left a temp file behind"

    assert SettingsStore(config_file=path, env={}).settings.max_concurrent == 7


def test_only_real_changes_are_reported(store: SettingsStore) -> None:
    store.update({"downloads.max_concurrent": 4})
    assert store.update({"downloads.max_concurrent": 4}) == frozenset()


def test_null_clears_an_override(store: SettingsStore) -> None:
    store.update({"downloads.max_concurrent": 8})
    store.update({"downloads.max_concurrent": None})
    assert store.settings.max_concurrent == 2
    assert store.sources["downloads.max_concurrent"] == "default"


def test_reset_clears_everything(store: SettingsStore) -> None:
    store.update({"downloads.max_concurrent": 8, "media.quality": "720p"})
    store.reset()
    assert store.settings.max_concurrent == 2
    assert store.download_defaults()["quality"] == "best"


def test_unknown_keys_are_refused(store: SettingsStore) -> None:
    with pytest.raises(SettingsError, match="unknown setting"):
        store.update({"downloads.nonsense": 1})


def test_env_pinned_settings_cannot_be_patched(tmp_path: Path) -> None:
    pinned = SettingsStore(config_file=tmp_path / "s.json", env={"MAX_CONCURRENT": "3"})
    assert pinned.is_locked("downloads.max_concurrent")
    with pytest.raises(SettingsError, match="pinned by the MAX_CONCURRENT"):
        pinned.update({"downloads.max_concurrent": 5})


def test_secrets_are_redacted(tmp_path: Path) -> None:
    secret = SettingsStore(config_file=tmp_path / "s.json", env={})
    secret.update({"server.api_token": "hunter2"})
    assert secret.values()["server.api_token"] == "********"
    assert secret.settings.api_token == "hunter2", "the service still needs the real value"


def test_restart_required_is_reported(store: SettingsStore) -> None:
    changed = store.update({"events.history": 500})
    assert store.restart_required(changed) == ["events.history"]
    assert store.restart_required(store.update({"downloads.max_concurrent": 3})) == []


def test_a_corrupt_config_file_does_not_stop_the_service(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{ not json", encoding="utf-8")
    broken = SettingsStore(config_file=path, env={})
    assert broken.settings.max_concurrent == 2
    assert broken.load_errors


# --- the API ----------------------------------------------------------------


def test_get_settings_returns_everything_a_ui_needs(client: TestClient) -> None:
    payload = client.get("/api/v1/settings").json()
    assert payload["values"]["downloads.max_concurrent"] == 2
    assert payload["download_defaults"]["quality"] == "best"
    assert payload["groups"]
    assert payload["config_file"]

    entry = next(s for s in payload["schema"] if s["key"] == "downloads.max_concurrent")
    assert entry["env"] == "MAX_CONCURRENT"
    assert entry["minimum"] == 1 and entry["maximum"] == 16
    assert entry["source"] == "file"
    assert entry["locked_by_env"] is False
    assert entry["runtime"] is True


def test_patch_applies_and_reports_the_change(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    response = client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 5}})
    assert response.status_code == 200
    payload = response.json()
    assert payload["changed"] == ["downloads.max_concurrent"]
    assert payload["values"]["downloads.max_concurrent"] == 5
    assert payload["restart_required"] == []
    assert client.get("/health").json()["max_concurrent"] == 5


def test_patch_rejects_unknown_keys(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    response = client.patch("/api/v1/settings", json={"values": {"nope.nope": 1}})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_patch_rejects_out_of_range_values(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    response = client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 99}})
    assert response.status_code == 422
    assert response.json()["error"]["detail"]["key"] == "downloads.max_concurrent"


def test_patching_an_env_pinned_setting_is_a_conflict(
    store_client: Callable[..., TestClient]
) -> None:
    """The UI needs to distinguish 'you typed something invalid' from 'the
    launcher pinned this', so they get different codes."""
    client = store_client(MAX_CONCURRENT="3")
    response = client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 5}})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "setting_locked"

    entry = next(
        s for s in client.get("/api/v1/settings").json()["schema"]
        if s["key"] == "downloads.max_concurrent"
    )
    assert entry["locked_by_env"] is True
    assert entry["source"] == "env"


def test_patch_can_reset(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    client.patch("/api/v1/settings", json={"values": {"media.quality": "720p"}})
    response = client.patch("/api/v1/settings", json={"reset": ["media.quality"]})
    assert response.json()["download_defaults"]["quality"] == "best"


def test_a_settings_change_is_broadcast(store_client: Callable[..., TestClient]) -> None:
    """Every connected client converges without polling."""
    client = store_client()
    with client.websocket_connect("/ws/events") as socket:
        assert socket.receive_json()["type"] == "hello"
        client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 4}})
        frame = socket.receive_json()

    assert frame["type"] == "settings.changed"
    assert frame["data"]["changed"] == ["downloads.max_concurrent"]
    assert frame["data"]["values"]["downloads.max_concurrent"] == 4
    assert set(frame) == {"type", "job_id", "ts", "seq", "data"}


def test_a_restart_only_change_says_so(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    payload = client.patch("/api/v1/settings", json={"values": {"events.history": 400}}).json()
    assert payload["restart_required"] == ["events.history"]


# --- settings actually take effect ------------------------------------------


def test_changing_concurrency_takes_effect_without_a_restart(
    store_client: Callable[..., TestClient]
) -> None:
    """The whole point: a slider must not kill in-flight downloads."""
    client = store_client()
    client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 1}})

    first = client.post("/api/v1/downloads", json={"url": "https://fake.test/slow"}).json()
    second = client.post("/api/v1/downloads", json={"url": "https://fake.test/slow"}).json()
    wait_for(client, first["job_id"], statuses={"downloading"}, timeout=10)
    assert client.get(f"/api/v1/downloads/{second['job_id']}").json()["status"] == "queued"

    # Raising the cap must admit the waiting job immediately.
    client.patch("/api/v1/settings", json={"values": {"downloads.max_concurrent": 2}})
    wait_for(client, second["job_id"], statuses={"downloading"}, timeout=10)
    assert client.get(f"/api/v1/downloads/{first['job_id']}").json()["status"] == "downloading"

    for job in (first, second):
        client.post(f"/api/v1/downloads/{job['job_id']}/cancel")


def test_changing_the_download_folder_takes_effect(
    store_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    client = store_client()
    elsewhere = tmp_path / "elsewhere"
    client.patch("/api/v1/settings", json={"values": {"downloads.directory": str(elsewhere)}})

    job = wait_for(client, client.post("/api/v1/downloads", json={"url": VIDEO}).json()["job_id"])
    # Files land in the folder itself, not a per-job subdirectory.
    assert job["files"]
    for entry in job["files"]:
        assert Path(entry["path"]).parent == elsewhere.resolve()


def test_changing_the_cache_ttl_takes_effect(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    client.get("/api/v1/info", params={"url": VIDEO})
    assert client.get("/api/v1/info", params={"url": VIDEO}).json()["cached"] is True

    client.patch("/api/v1/settings", json={"values": {"metadata.cache_ttl": 0}})
    assert client.get("/api/v1/info", params={"url": VIDEO}).json()["cached"] is False


# --- download defaults ------------------------------------------------------


def test_a_bare_url_inherits_the_saved_defaults(
    store_client: Callable[..., TestClient]
) -> None:
    """A client can post just a URL and still get the user's preferences."""
    client = store_client()
    client.patch(
        "/api/v1/settings",
        json={"values": {"media.quality": "720p", "media.container": "mkv"}},
    )
    job = client.post("/api/v1/downloads", json={"url": VIDEO}).json()
    assert job["options"]["quality"] == "720p"
    assert job["options"]["merge_output_format"] == "mkv"
    assert "height<=720" in job["options"]["format"]


def test_an_explicit_field_beats_the_default(store_client: Callable[..., TestClient]) -> None:
    client = store_client()
    client.patch("/api/v1/settings", json={"values": {"media.quality": "720p"}})
    job = client.post("/api/v1/downloads", json={"url": VIDEO, "quality": "480p"}).json()
    assert job["options"]["quality"] == "480p"


def test_defaults_do_not_mask_an_explicit_false(
    store_client: Callable[..., TestClient]
) -> None:
    """A client sending embed_thumbnail=false must win over a default of true,
    which naive dict merging on truthiness gets wrong."""
    client = store_client()
    job = client.post(
        "/api/v1/downloads", json={"url": VIDEO, "embed_thumbnail": False}
    ).json()
    assert job["options"]["embed_thumbnail"] is False


# --- filename templates -----------------------------------------------------


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("{title}.{ext}", "%(title)s.%(ext)s"),
        ("{uploader} - {title}.{ext}", "%(uploader)s - %(title)s.%(ext)s"),
        ("%(title)s.%(ext)s", "%(title)s.%(ext)s"),
        ("plain-name.mp4", "plain-name.mp4"),
    ],
)
def test_friendly_templates_are_translated(given: str, expected: str) -> None:
    """A settings panel offers {title}.{ext}; untranslated, yt-dlp would write a
    file genuinely called '{title}.{ext}'."""
    assert translate_template(given) == expected


def test_a_friendly_template_reaches_yt_dlp_translated(
    store_client: Callable[..., TestClient], fake_ydl: Any
) -> None:
    client = store_client()
    client.patch(
        "/api/v1/settings", json={"values": {"downloads.output_template": "{title}.{ext}"}}
    )
    job = client.post("/api/v1/downloads", json={"url": VIDEO}).json()
    wait_for(client, job["job_id"])
    assert "%(title)s" in fake_ydl.instances[-1].opts["outtmpl"]["default"]
    assert any(entry["name"].startswith("Fake Video.") for entry in
               client.get(f"/api/v1/downloads/{job['job_id']}").json()["files"])


# --- generated TypeScript ---------------------------------------------------


def test_the_typescript_covers_every_setting() -> None:
    source = emit_typescript()
    for setting in SETTINGS:
        assert f'"{setting.key}"' in source, setting.key
    assert "export type InfernoSettings" in source
    assert "export const SETTINGS_DEFAULTS" in source
    assert "locked_by_env" in source


def test_choice_settings_become_literal_unions() -> None:
    source = emit_typescript()
    assert '"media.mode": "video" | "audio"' in source


def test_nullable_settings_are_nullable_in_typescript() -> None:
    assert '"network.proxy": string | null' in emit_typescript()
