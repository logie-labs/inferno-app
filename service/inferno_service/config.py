"""Settings: one schema, layered sources, observable changes (SPEC §9).

The shape here is the one modern applications converge on — VS Code, Cargo and
Kubernetes all work this way — because it is the only arrangement that stays
pleasant once there are forty settings and three clients.

**One declarative schema.** Every setting is described exactly once, in
:data:`SETTINGS`. Env parsing, file validation, the REST API, the UI metadata
and the generated TypeScript are all derived from that table. Adding a setting
means adding one row; nothing else has to be touched, and nothing can drift.

**Layered sources with provenance.** The effective value comes from
``default -> file -> env``, and the service can always say which layer won. That
is what lets a settings UI grey out a control the environment has pinned instead
of silently discarding what the user typed.

**Two scopes.** ``service`` settings configure the running process.
``download`` settings are the defaults a new job inherits when a client omits a
field. Keeping them in one table but distinguishing the scope is what lets a
client send ``{"url": ...}`` and still get the user's chosen quality.

**Changes are events, not restarts.** :class:`SettingsStore` applies what it can
live and announces every change on the event bus, so all connected clients
converge without polling.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "Setting",
    "SETTINGS",
    "SETTINGS_BY_KEY",
    "Settings",
    "SettingsStore",
    "SettingsError",
    "SCHEMA_VERSION",
    "DEFAULT_CONFIG_FILE",
]

#: Bumped when the on-disk shape changes in a way that needs migrating.
SCHEMA_VERSION = 1

#: Where settings persist when the host does not choose. A Tauri app should set
#: ``INFERNO_CONFIG_FILE`` to a path inside its own app-data directory.
DEFAULT_CONFIG_FILE = "./inferno-settings.json"

Env = Mapping[str, str]

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class SettingsError(ValueError):
    """A setting was given a value the schema does not allow."""

    def __init__(self, key: str, message: str) -> None:
        super().__init__(f"{key}: {message}")
        self.key = key
        self.reason = message


@dataclass(frozen=True)
class Setting:
    """One setting, described once and used everywhere."""

    #: Dotted, namespaced, stable. This is the key clients and files use.
    key: str
    #: Attribute on :class:`Settings` (service scope) or field on
    #: ``DownloadRequest`` (download scope).
    field: str
    type: str  # int | float | bool | string | path | string_list | choice
    default: Any
    group: str
    label: str
    description: str
    scope: str = "service"  # service | download
    env: str | None = None
    #: False when the process must restart for a change to take effect.
    runtime: bool = True
    #: Never echoed back in full by the API.
    secret: bool = False
    minimum: float | None = None
    maximum: float | None = None
    choices: tuple[Any, ...] | None = None
    unit: str | None = None
    nullable: bool = False

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "type": self.type,
            "default": self.default,
            "group": self.group,
            "label": self.label,
            "description": self.description,
            "scope": self.scope,
            "env": self.env,
            "runtime": self.runtime,
            "secret": self.secret,
            "nullable": self.nullable,
        }
        for name in ("minimum", "maximum", "unit"):
            value = getattr(self, name)
            if value is not None:
                payload[name] = value
        if self.choices is not None:
            payload["choices"] = list(self.choices)
        return payload


QUALITY_CHOICES = (
    "best", "4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p", "worst",
)
AUDIO_FORMAT_CHOICES = ("best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav")
CONTAINER_CHOICES = ("mp4", "mkv", "webm", "mov", "flv", "avi")


#: The single source of truth. Add a row and it appears in the env parser, the
#: config file, ``GET /api/v1/settings``, the generated TypeScript and the UI.
SETTINGS: tuple[Setting, ...] = (
    # --- service: downloads ------------------------------------------------
    Setting(
        key="downloads.directory",
        field="download_dir",
        type="path",
        default="./downloads",
        group="downloads",
        label="Download folder",
        description="One subdirectory per job id is created inside this folder.",
        env="DOWNLOAD_DIR",
    ),
    Setting(
        key="downloads.state_file",
        field="state_file",
        type="path",
        default="",
        group="downloads",
        label="Remember finished jobs in",
        description=(
            "A file to keep the finished queue in, so it survives a restart. "
            "Empty keeps jobs in memory only, which is the default."
        ),
        env="STATE_FILE",
        runtime=False,
    ),
    Setting(
        key="downloads.max_concurrent",
        field="max_concurrent",
        type="int",
        default=2,
        group="downloads",
        label="Concurrent downloads",
        description="How many downloads run at once. The rest queue.",
        env="MAX_CONCURRENT",
        minimum=1,
        maximum=16,
    ),
    Setting(
        key="downloads.job_ttl",
        field="job_ttl",
        type="int",
        default=86_400,
        group="downloads",
        label="Keep finished jobs for",
        description="Seconds a finished job is retained before it and its files are swept.",
        env="JOB_TTL",
        minimum=0,
        unit="seconds",
    ),
    # --- service: network --------------------------------------------------
    Setting(
        key="network.retries",
        field="retries",
        type="int",
        default=10,
        group="network",
        label="Retries",
        description="How many times a failed request or fragment is retried.",
        env="RETRIES",
        minimum=0,
        maximum=50,
    ),
    Setting(
        key="network.proxy",
        field="proxy",
        type="string",
        default=None,
        group="network",
        label="Proxy URL",
        description="An http, https or socks5 proxy for extraction and downloads.",
        env="PROXY",
        nullable=True,
    ),
    Setting(
        key="network.http_chunk_size",
        field="http_chunk_size",
        type="int",
        default=262_144,
        group="network",
        label="HTTP chunk size",
        description="Forces ranged GETs. 0 disables chunking.",
        env="HTTP_CHUNK_SIZE",
        minimum=0,
        unit="bytes",
    ),
    # --- service: privacy --------------------------------------------------
    Setting(
        key="privacy.cookies_from_browser",
        field="cookies_from_browser",
        type="string",
        default=None,
        group="privacy",
        label="Cookies from browser",
        description=(
            "Read cookies from this browser, e.g. 'firefox' or 'chrome:Default'. "
            "YouTube caps un-tokened downloads without them."
        ),
        env="COOKIES_FROM_BROWSER",
        nullable=True,
    ),
    Setting(
        key="privacy.cookie_file",
        field="cookie_file",
        type="path",
        default=None,
        group="privacy",
        label="Cookie file",
        description="A Netscape cookie file. Takes precedence over the browser setting.",
        env="COOKIE_FILE",
        nullable=True,
    ),
    # --- service: binaries -------------------------------------------------
    Setting(
        key="binaries.ffmpeg_dir",
        field="ffmpeg_dir",
        type="path",
        default=None,
        group="binaries",
        label="ffmpeg directory",
        description="Directory or binary path. Overrides the bundled copy and PATH.",
        env="FFMPEG_DIR",
        nullable=True,
    ),
    Setting(
        key="binaries.js_runtime_dir",
        field="js_runtime_dir",
        type="path",
        default=None,
        group="binaries",
        label="JavaScript runtime directory",
        description="Directory or binary path for QuickJS. Required by YouTube.",
        env="JS_RUNTIME_DIR",
        nullable=True,
    ),
    # --- service: server ---------------------------------------------------
    Setting(
        key="server.api_token",
        field="api_token",
        type="string",
        default=None,
        group="server",
        label="API token",
        description="When set, every request must carry it as X-API-Key or ?token=.",
        env="API_TOKEN",
        runtime=False,
        secret=True,
        nullable=True,
    ),
    Setting(
        key="server.cors_origins",
        field="cors_origins",
        type="string_list",
        default=["*"],
        group="server",
        label="Allowed origins",
        description="Browser origins permitted to call the API.",
        env="CORS_ORIGINS",
        runtime=False,
    ),
    Setting(
        key="server.serve_files",
        field="serve_files",
        type="bool",
        default=True,
        group="server",
        label="Serve finished files",
        description="Turn off when something else serves the output directory.",
        env="SERVE_FILES",
    ),
    Setting(
        key="events.history",
        field="event_history",
        type="int",
        default=250,
        group="server",
        label="Event buffer size",
        description="Events retained per channel for websocket replay.",
        env="EVENT_HISTORY",
        minimum=1,
        maximum=10_000,
        runtime=False,
    ),
    Setting(
        key="events.progress_interval",
        field="progress_interval",
        type="float",
        default=0.25,
        group="server",
        label="Progress interval",
        description="Minimum seconds between progress events. Lower is chattier.",
        env="PROGRESS_INTERVAL",
        minimum=0.0,
        maximum=5.0,
        unit="seconds",
    ),
    Setting(
        key="metadata.cache_ttl",
        field="info_cache_ttl",
        type="int",
        default=300,
        group="server",
        label="Metadata cache",
        description="Seconds extracted metadata is reused. 0 disables the cache.",
        env="INFO_CACHE_TTL",
        minimum=0,
        unit="seconds",
    ),
    # --- download defaults: what a new job inherits ------------------------
    Setting(
        key="media.mode",
        field="mode",
        type="choice",
        default="video",
        group="media",
        label="Default mode",
        description="Whether a new job downloads video or audio only.",
        scope="download",
        choices=("video", "audio"),
    ),
    Setting(
        key="media.quality",
        field="quality",
        type="choice",
        default="best",
        group="media",
        label="Default quality",
        description="Height cap for video downloads.",
        scope="download",
        choices=QUALITY_CHOICES,
    ),
    Setting(
        key="media.container",
        field="container",
        type="choice",
        default=None,
        group="media",
        label="Default container",
        description="Preferred output container. Unset lets the server choose.",
        scope="download",
        choices=CONTAINER_CHOICES,
        nullable=True,
    ),
    Setting(
        key="media.audio_format",
        field="audio_format",
        type="choice",
        default=None,
        group="media",
        label="Default audio format",
        description="Re-encode extracted audio to this codec. Unset keeps the source.",
        scope="download",
        choices=AUDIO_FORMAT_CHOICES,
        nullable=True,
    ),
    Setting(
        key="media.audio_quality",
        field="audio_quality",
        type="int",
        default=192,
        group="media",
        label="Audio bitrate",
        description="Target bitrate when re-encoding audio.",
        scope="download",
        minimum=0,
        maximum=320,
        unit="kbps",
    ),
    Setting(
        key="media.embed_thumbnail",
        field="embed_thumbnail",
        type="bool",
        default=True,
        group="media",
        label="Embed thumbnail",
        description="Requires ffmpeg.",
        scope="download",
    ),
    Setting(
        key="media.embed_metadata",
        field="embed_metadata",
        type="bool",
        default=True,
        group="media",
        label="Embed metadata",
        description="Requires ffmpeg.",
        scope="download",
    ),
    Setting(
        key="media.embed_subtitles",
        field="embed_subtitles",
        type="bool",
        default=False,
        group="media",
        label="Embed subtitles",
        description="Mux subtitles into the output. Requires ffmpeg.",
        scope="download",
    ),
    Setting(
        key="media.subtitles",
        field="subtitles",
        type="string_list",
        default=[],
        group="media",
        label="Subtitle languages",
        description="Language codes to fetch, e.g. en, es. Empty fetches none.",
        scope="download",
    ),
    Setting(
        key="media.auto_subtitles",
        field="auto_subtitles",
        type="bool",
        default=False,
        group="media",
        label="Automatic captions",
        description="Also fetch machine-generated captions.",
        scope="download",
    ),
    Setting(
        key="media.write_thumbnail",
        field="write_thumbnail",
        type="bool",
        default=False,
        group="media",
        label="Save thumbnail file",
        description="Write the thumbnail alongside the media as its own file.",
        scope="download",
    ),
    Setting(
        key="downloads.output_template",
        field="output_template",
        type="string",
        default=None,
        group="downloads",
        label="Filename template",
        description=(
            "Output filename, relative to the job folder. Accepts friendly "
            "placeholders like {title}.{ext} as well as yt-dlp's own syntax."
        ),
        scope="download",
        nullable=True,
    ),
    Setting(
        key="downloads.concurrent_fragments",
        field="concurrent_fragments",
        type="int",
        default=4,
        group="downloads",
        label="Parallel fragments",
        description="Fragments downloaded in parallel for HLS and DASH.",
        scope="download",
        minimum=1,
        maximum=16,
    ),
    Setting(
        key="downloads.playlist",
        field="playlist",
        type="bool",
        default=False,
        group="downloads",
        label="Download whole playlists",
        description="When a URL is a playlist, fetch every entry rather than one video.",
        scope="download",
    ),
    Setting(
        key="network.rate_limit",
        field="rate_limit",
        type="int",
        default=None,
        group="network",
        label="Speed limit",
        description="Cap the download rate. Unset means unlimited.",
        scope="download",
        minimum=1,
        unit="bytes/s",
        nullable=True,
    ),
)

SETTINGS_BY_KEY: dict[str, Setting] = {s.key: s for s in SETTINGS}
SERVICE_SETTINGS: tuple[Setting, ...] = tuple(s for s in SETTINGS if s.scope == "service")
DOWNLOAD_SETTINGS: tuple[Setting, ...] = tuple(s for s in SETTINGS if s.scope == "download")


# --- coercion ---------------------------------------------------------------


def coerce(setting: Setting, value: Any, *, from_env: bool = False) -> Any:
    """Validate and convert one value against its schema row."""
    if value is None:
        if setting.nullable or setting.default is None:
            return None
        raise SettingsError(setting.key, "is not nullable")

    kind = setting.type
    try:
        if kind == "bool":
            if isinstance(value, bool):
                result: Any = value
            else:
                text = str(value).strip().lower()
                if text in _TRUE:
                    result = True
                elif text in _FALSE:
                    result = False
                else:
                    raise SettingsError(setting.key, f"expected a boolean, got {value!r}")
        elif kind == "int":
            if isinstance(value, bool):
                raise SettingsError(setting.key, "expected an integer, got a boolean")
            result = int(value)
        elif kind == "float":
            if isinstance(value, bool):
                raise SettingsError(setting.key, "expected a number, got a boolean")
            result = float(value)
        elif kind == "string_list":
            if isinstance(value, str):
                result = [part.strip() for part in value.split(",") if part.strip()]
            elif isinstance(value, Sequence):
                result = [str(item).strip() for item in value if str(item).strip()]
            else:
                raise SettingsError(setting.key, f"expected a list, got {value!r}")
        elif kind in {"string", "path", "choice"}:
            text = str(value).strip()
            if not text:
                if setting.nullable or setting.default is None:
                    return None
                raise SettingsError(setting.key, "must not be empty")
            result = text
        else:  # pragma: no cover - guarded by the table itself
            raise SettingsError(setting.key, f"unknown setting type {kind!r}")
    except SettingsError:
        raise
    except (TypeError, ValueError) as exc:
        raise SettingsError(setting.key, f"expected {kind}, got {value!r}") from exc

    if setting.choices is not None and result not in setting.choices:
        allowed = ", ".join(str(c) for c in setting.choices)
        raise SettingsError(setting.key, f"must be one of: {allowed}")
    if setting.minimum is not None and isinstance(result, (int, float)) and result < setting.minimum:
        if from_env:
            result = type(result)(setting.minimum)
        else:
            raise SettingsError(setting.key, f"must be at least {setting.minimum}")
    if setting.maximum is not None and isinstance(result, (int, float)) and result > setting.maximum:
        if from_env:
            result = type(result)(setting.maximum)
        else:
            raise SettingsError(setting.key, f"must be at most {setting.maximum}")
    return result


# --- the immutable effective snapshot ---------------------------------------


@dataclass(frozen=True)
class Settings:
    """The effective service configuration at a point in time.

    Frozen on purpose: components hold a snapshot and are handed a new one when
    something changes, so a value can never shift underneath a running job.
    """

    download_dir: Path = Path("./downloads")
    #: Where the finished queue is remembered, or "" to keep it in memory only
    #: (the default, and what the desktop uses).
    state_file: str = ""
    max_concurrent: int = 2
    job_ttl: int = 86_400
    event_history: int = 250
    progress_interval: float = 0.25
    info_cache_ttl: int = 300
    api_token: str | None = None
    cors_origins: tuple[str, ...] = ("*",)
    ffmpeg_dir: str | None = None
    js_runtime_dir: str | None = None
    cookies_from_browser: str | None = None
    cookie_file: str | None = None
    http_chunk_size: int = 262_144
    serve_files: bool = True
    retries: int = 10
    proxy: str | None = None

    @classmethod
    def from_values(cls, values: Mapping[str, Any]) -> "Settings":
        """Build a snapshot from dotted-key values."""
        kwargs: dict[str, Any] = {}
        for setting in SERVICE_SETTINGS:
            if setting.key not in values:
                continue
            value = values[setting.key]
            if setting.field == "download_dir":
                value = Path(str(value))
            elif setting.field == "cors_origins":
                value = tuple(value or ["*"])
            kwargs[setting.field] = value
        return cls(**kwargs)

    @classmethod
    def from_env(cls, env: Env | None = None) -> "Settings":
        """Defaults overlaid with the environment. The simple path, still supported."""
        layers = resolve_layers(env=env)
        return cls.from_values(layers.values)

    def replace(self, **changes: object) -> "Settings":
        return replace(self, **changes)  # type: ignore[arg-type]

    @property
    def auth_required(self) -> bool:
        return bool(self.api_token)

    def resolved_download_dir(self) -> Path:
        return self.download_dir.expanduser().resolve()

    def to_values(self) -> dict[str, Any]:
        """Back to dotted keys, for the API and for comparison."""
        values: dict[str, Any] = {}
        for setting in SERVICE_SETTINGS:
            value = getattr(self, setting.field)
            if isinstance(value, Path):
                value = str(value)
            elif isinstance(value, tuple):
                value = list(value)
            values[setting.key] = value
        return values


# --- layers -----------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedLayers:
    """Effective values plus where each one came from."""

    values: dict[str, Any]
    sources: dict[str, str]  # key -> "default" | "file" | "env"
    file_values: dict[str, Any]
    env_keys: frozenset[str]
    errors: tuple[str, ...] = ()


def resolve_layers(
    file_values: Mapping[str, Any] | None = None, env: Env | None = None
) -> ResolvedLayers:
    """Compute ``default -> file -> env`` and remember which layer won.

    The two layers fail differently, on purpose. The environment is set by
    whoever launched the process, so a bad value there is an operator mistake
    and raises immediately. The file is user-editable state, so a bad value
    there is reported through :attr:`ResolvedLayers.errors` and skipped — a
    hand-edited config should never stop the service from starting.
    """
    environ = os.environ if env is None else env
    stored = dict(file_values or {})
    values: dict[str, Any] = {}
    sources: dict[str, str] = {}
    env_keys: set[str] = set()
    errors: list[str] = []

    for setting in SETTINGS:
        values[setting.key] = setting.default
        sources[setting.key] = "default"

        if setting.key in stored:
            try:
                values[setting.key] = coerce(setting, stored[setting.key])
                sources[setting.key] = "file"
            except SettingsError as exc:
                errors.append(str(exc))

        if setting.env:
            raw = environ.get(setting.env)
            if raw is not None and str(raw).strip():
                try:
                    values[setting.key] = coerce(setting, raw, from_env=True)
                except SettingsError as exc:
                    raise SettingsError(
                        setting.key, f"{setting.env}={raw!r} is invalid: {exc.reason}"
                    ) from exc
                sources[setting.key] = "env"
                env_keys.add(setting.key)

    return ResolvedLayers(
        values=values,
        sources=sources,
        file_values=stored,
        env_keys=frozenset(env_keys),
        errors=tuple(errors),
    )


# --- persistence and runtime application ------------------------------------


def _read_config_file(path: Path) -> tuple[dict[str, Any], str | None]:
    if not path.is_file():
        return {}, None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {}, f"could not read {path}: {exc}"
    if not isinstance(payload, Mapping):
        return {}, f"{path} does not contain a settings object"
    values = payload.get("values")
    if not isinstance(values, Mapping):
        return {}, None
    return dict(values), None


def _write_config_file(path: Path, values: Mapping[str, Any]) -> None:
    """Write atomically, so a crash mid-write cannot corrupt the file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema_version": SCHEMA_VERSION, "values": dict(values)}
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), prefix=path.name, suffix=".tmp", delete=False
    )
    try:
        with handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, path)
    except BaseException:
        Path(handle.name).unlink(missing_ok=True)
        raise


class SettingsStore:
    """Owns the layers and persists the file one.

    :meth:`update` returns the dotted keys whose effective value actually moved,
    which is what the caller broadcasts as a ``settings.changed`` event so every
    connected client converges without polling.
    """

    def __init__(
        self,
        config_file: str | Path | None = None,
        env: Env | None = None,
        *,
        persist: bool = True,
    ) -> None:
        environ = os.environ if env is None else env
        self._env = environ
        self._persist = persist
        chosen = config_file if config_file is not None else environ.get("INFERNO_CONFIG_FILE")
        self.config_file = Path(chosen or DEFAULT_CONFIG_FILE).expanduser()
        self._lock = threading.RLock()

        stored, read_error = _read_config_file(self.config_file)
        self._layers = resolve_layers(stored, environ)
        self.load_errors: tuple[str, ...] = tuple(
            ([read_error] if read_error else []) + list(self._layers.errors)
        )
        self._settings = Settings.from_values(self._layers.values)

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> "SettingsStore":
        """Wrap an explicit snapshot. Used by tests and by embedders."""
        store = cls(config_file=kwargs.pop("config_file", None), env={}, persist=False, **kwargs)
        store._layers = resolve_layers(settings.to_values(), {})
        store._settings = Settings.from_values(store._layers.values)
        return store

    # --- reading -----------------------------------------------------------

    @property
    def settings(self) -> Settings:
        with self._lock:
            return self._settings

    @property
    def sources(self) -> dict[str, str]:
        with self._lock:
            return dict(self._layers.sources)

    def values(self, *, scope: str | None = None, redact: bool = True) -> dict[str, Any]:
        with self._lock:
            result = {}
            for setting in SETTINGS:
                if scope and setting.scope != scope:
                    continue
                value = self._layers.values[setting.key]
                if redact and setting.secret and value:
                    value = "********"
                result[setting.key] = value
            return result

    def download_defaults(self) -> dict[str, Any]:
        """Download-scope values keyed by ``DownloadRequest`` field name."""
        with self._lock:
            return {
                setting.field: self._layers.values[setting.key]
                for setting in DOWNLOAD_SETTINGS
                if self._layers.values[setting.key] is not None
            }

    def is_locked(self, key: str) -> bool:
        with self._lock:
            return key in self._layers.env_keys

    def describe(self) -> list[dict[str, Any]]:
        """The schema, annotated with the live state of each setting."""
        with self._lock:
            described = []
            for setting in SETTINGS:
                entry = setting.to_dict()
                entry["source"] = self._layers.sources[setting.key]
                entry["locked_by_env"] = setting.key in self._layers.env_keys
                value = self._layers.values[setting.key]
                entry["value"] = "********" if setting.secret and value else value
                described.append(entry)
            return described

    # --- writing -----------------------------------------------------------

    def update(self, patch: Mapping[str, Any]) -> frozenset[str]:
        """Apply a partial change. ``None`` clears an override.

        Returns the dotted keys whose effective value actually moved. Unknown
        keys and env-locked keys raise, so a settings UI never silently loses a
        user's edit.
        """
        with self._lock:
            unknown = [key for key in patch if key not in SETTINGS_BY_KEY]
            if unknown:
                raise SettingsError(
                    unknown[0], f"unknown setting (valid keys: {len(SETTINGS_BY_KEY)} in the schema)"
                )

            locked = [key for key in patch if key in self._layers.env_keys]
            if locked:
                raise SettingsError(
                    locked[0],
                    f"is pinned by the {SETTINGS_BY_KEY[locked[0]].env} environment variable "
                    "and cannot be changed at runtime",
                )

            stored = dict(self._layers.file_values)
            for key, value in patch.items():
                setting = SETTINGS_BY_KEY[key]
                if value is None and not setting.nullable:
                    stored.pop(key, None)  # clear the override, fall back
                else:
                    stored[key] = coerce(setting, value)

            layers = resolve_layers(stored, self._env)
            if layers.errors:  # pragma: no cover - patch values are pre-coerced
                raise SettingsError(list(patch)[0], "; ".join(layers.errors))

            before = self._layers.values
            changed = frozenset(
                key for key in layers.values if layers.values[key] != before.get(key)
            )
            self._layers = layers
            self._settings = Settings.from_values(layers.values)

            if self._persist:
                _write_config_file(self.config_file, stored)

        return changed

    def reset(self, keys: Iterable[str] | None = None) -> frozenset[str]:
        """Drop file overrides for ``keys`` (or all of them)."""
        targets = list(keys) if keys is not None else list(self._layers.file_values)
        return self.update({key: None for key in targets if key in SETTINGS_BY_KEY})

    def restart_required(self, changed: Iterable[str]) -> list[str]:
        return [key for key in changed if not SETTINGS_BY_KEY[key].runtime]


def _ts_type(setting: Setting) -> str:
    if setting.choices is not None:
        base = " | ".join(json.dumps(choice) for choice in setting.choices)
    elif setting.type in {"int", "float"}:
        base = "number"
    elif setting.type == "bool":
        base = "boolean"
    elif setting.type == "string_list":
        base = "string[]"
    else:
        base = "string"
    if setting.nullable or setting.default is None:
        base += " | null"
    return base


def emit_typescript() -> str:
    """Generate the TypeScript the desktop app imports.

    The point is that the frontend never hand-maintains a copy of the settings
    shape. Regenerate after changing :data:`SETTINGS` and the app's types, its
    defaults and its rendering metadata all move together; forget to, and
    ``tsc`` complains rather than the app silently sending an unknown key.
    """
    lines: list[str] = [
        "// Generated by `python -m inferno_service --emit-typescript`.",
        "// Do not edit by hand; regenerate when the settings schema changes.",
        "",
        f"export const SETTINGS_SCHEMA_VERSION = {SCHEMA_VERSION}",
        "",
        'export type SettingScope = "service" | "download"',
        'export type SettingType =',
        '  | "int"',
        '  | "float"',
        '  | "bool"',
        '  | "string"',
        '  | "path"',
        '  | "string_list"',
        '  | "choice"',
        "",
        "export type SettingDescriptor = {",
        "  key: SettingKey",
        "  type: SettingType",
        "  default: unknown",
        "  value: unknown",
        "  group: string",
        "  label: string",
        "  description: string",
        "  scope: SettingScope",
        "  env: string | null",
        "  runtime: boolean",
        "  secret: boolean",
        "  nullable: boolean",
        "  /** Which layer supplied the effective value. */",
        '  source: "default" | "file" | "env"',
        "  /** True when an environment variable pins it; the UI should disable the control. */",
        "  locked_by_env: boolean",
        "  minimum?: number",
        "  maximum?: number",
        "  unit?: string",
        "  choices?: unknown[]",
        "}",
        "",
    ]

    def block(name: str, rows: Iterable[Setting], doc: str) -> None:
        lines.append(f"/** {doc} */")
        lines.append(f"export type {name} = {{")
        for setting in rows:
            lines.append(f"  /** {setting.label}. {setting.description} */")
            lines.append(f'  {json.dumps(setting.key)}: {_ts_type(setting)}')
        lines.append("}")
        lines.append("")

    block(
        "ServiceSettings",
        SERVICE_SETTINGS,
        "Settings that configure the running service.",
    )
    block(
        "DownloadDefaults",
        DOWNLOAD_SETTINGS,
        "Defaults a new download inherits when the client omits the field.",
    )

    lines.append("export type InfernoSettings = ServiceSettings & DownloadDefaults")
    lines.append("export type SettingKey = keyof InfernoSettings")
    lines.append("")

    lines.append("/** Every default, exactly as the service would compute it. */")
    lines.append("export const SETTINGS_DEFAULTS: InfernoSettings = {")
    for setting in SETTINGS:
        lines.append(f"  {json.dumps(setting.key)}: {json.dumps(setting.default)},")
    lines.append("}")
    lines.append("")

    lines.append("/** Rendering metadata, so a settings screen can be generated. */")
    lines.append("export const SETTINGS_SCHEMA: readonly Omit<SettingDescriptor,")
    lines.append('  "value" | "source" | "locked_by_env">[] = [')
    for setting in SETTINGS:
        lines.append(f"  {json.dumps(setting.to_dict(), sort_keys=True)},")
    lines.append("]")
    lines.append("")

    lines.append("/** Group order for the settings sidebar. */")
    lines.append(
        "export const SETTINGS_GROUPS: readonly { id: string; keys: SettingKey[] }[] = "
        + json.dumps(settings_groups(), indent=2)
    )
    lines.append("")
    return "\n".join(lines)


def settings_groups() -> list[dict[str, Any]]:
    """Group ordering for a settings UI, derived from the table."""
    order: list[str] = []
    for setting in SETTINGS:
        if setting.group not in order:
            order.append(setting.group)
    return [
        {"id": name, "keys": [s.key for s in SETTINGS if s.group == name]} for name in order
    ]
