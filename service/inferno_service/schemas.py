"""Pydantic request/response models (SPEC §3, §4, §7).

Requests set ``extra="forbid"``: a typo in someone's integration fails loudly at
the boundary instead of being silently ignored (SPEC §4).

Requests carry **intent**, never yt-dlp internals. The translation to yt-dlp
options lives in exactly one place, :mod:`inferno_service.options`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "Mode",
    "Quality",
    "AudioFormat",
    "Container",
    "DownloadRequest",
    "InfoRequest",
    "JobStatus",
    "FileModel",
    "JobModel",
    "JobListResponse",
    "HealthResponse",
    "ErrorBody",
    "ErrorResponse",
    "InfoResponse",
    "FormatsResponse",
    "SubtitlesResponse",
    "SettingsPatch",
    "SettingDescriptor",
    "SettingsResponse",
]

Mode = Literal["video", "audio"]
Quality = Literal[
    "best", "4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p", "worst"
]
AudioFormat = Literal["best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav"]
Container = Literal["mp4", "mkv", "webm", "mov", "flv", "avi"]
JobStatus = Literal[
    "queued", "extracting", "downloading", "postprocessing", "completed", "failed", "cancelled"
]

TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "cancelled"})


class StrictModel(BaseModel):
    """Base for request bodies: unknown fields are an error, not a shrug."""

    model_config = ConfigDict(extra="forbid")


class OpenModel(BaseModel):
    """Base for responses, which may grow fields without breaking clients."""

    model_config = ConfigDict(extra="allow")


def _validate_url(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("url must not be empty")
    return stripped


class InfoRequest(StrictModel):
    """Body for ``POST /api/v1/info``."""

    url: str = Field(..., description="The page URL to extract metadata from.")
    playlist: bool = Field(
        False, description="Resolve a playlist into its entries instead of a single video."
    )
    refresh: bool = Field(False, description="Bypass the metadata cache for this request.")

    _check_url = field_validator("url")(_validate_url)


class DownloadRequest(StrictModel):
    """Body for ``POST /api/v1/downloads`` — intent only (SPEC §7)."""

    url: str = Field(..., description="The page URL to download.")
    mode: Mode = Field("video", description="What the client wants: a video file or audio only.")
    quality: Quality = Field(
        "best", description="Height cap for video mode. Ignored when mode is audio."
    )
    format_id: str | None = Field(
        None,
        description=(
            "Escape hatch: an explicit yt-dlp format id. Honoured only when it is "
            "compatible with mode; a merged 'a+b' id with mode=audio is rejected."
        ),
    )
    audio_format: AudioFormat | None = Field(
        None,
        description=(
            "Re-encode/remux extracted audio to this codec. Requires ffmpeg. "
            "None keeps the downloaded audio stream as-is."
        ),
    )
    audio_quality: Annotated[int, Field(ge=0, le=320)] = Field(
        192, description="Target audio bitrate in kbps (or 0-10 as a VBR scale)."
    )
    container: Container | None = Field(
        None, description="Preferred output container for video mode. Ignored when mode is audio."
    )
    playlist: bool = Field(False, description="Download every entry when the URL is a playlist.")
    subtitles: list[str] = Field(
        default_factory=list, description="Subtitle language codes to fetch, e.g. ['en', 'es']."
    )
    auto_subtitles: bool = Field(False, description="Also fetch automatic captions.")
    embed_subtitles: bool = Field(False, description="Mux subtitles into the output. Requires ffmpeg.")
    write_thumbnail: bool = Field(False, description="Write the thumbnail as a sidecar file.")
    embed_thumbnail: bool = Field(True, description="Embed the thumbnail. Requires ffmpeg.")
    embed_metadata: bool = Field(True, description="Embed title/artist metadata. Requires ffmpeg.")
    filename_case: Literal["original", "kebab", "snake", "lower", "title"] = Field(
        "original",
        description=(
            "Case applied to the finished file's name. yt-dlp's output template "
            "has no case conversion, so this is applied when the file is moved "
            "into the download folder."
        ),
    )
    output_template: str | None = Field(
        None,
        description=(
            "yt-dlp output template, relative to the job directory. "
            "Absolute paths and parent traversal are rejected."
        ),
    )
    concurrent_fragments: Annotated[int, Field(ge=1, le=16)] = Field(
        4, description="Parallel fragment downloads for HLS/DASH."
    )
    rate_limit: Annotated[int, Field(ge=1)] | None = Field(
        None, description="Download rate cap in bytes per second."
    )

    _check_url = field_validator("url")(_validate_url)

    @field_validator("format_id")
    @classmethod
    def _clean_format_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None

    @field_validator("subtitles")
    @classmethod
    def _clean_subtitles(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for lang in value:
            code = lang.strip()
            if not code:
                continue
            if not all(ch.isalnum() or ch in "-_." for ch in code) and code != "all":
                raise ValueError(f"invalid subtitle language code: {lang!r}")
            if code not in cleaned:
                cleaned.append(code)
        return cleaned

    @field_validator("output_template")
    @classmethod
    def _check_template(cls, value: str | None) -> str | None:
        if value is None:
            return None
        template = value.strip()
        if not template:
            return None
        if template.startswith(("/", "\\")) or (len(template) > 1 and template[1] == ":"):
            raise ValueError("output_template must be relative to the job directory")
        parts = template.replace("\\", "/").split("/")
        if ".." in parts:
            raise ValueError("output_template must not traverse outside the job directory")
        return template


class FileModel(OpenModel):
    """One finished artefact, fetchable through the API (SPEC §4)."""

    name: str
    size: int
    mime: str | None = None
    modified: float | None = None
    url: str
    #: Absolute path on the machine running the service, for a local client
    #: that wants to open or reveal the file. The bytes still come from ``url``.
    path: str | None = None


class ProgressModel(OpenModel):
    """The most recent progress tick. Raw values only (SPEC §1)."""

    status: str | None = None
    downloaded_bytes: int | None = None
    total_bytes: int | None = None
    total_bytes_estimate: int | None = None
    percent: float | None = None
    speed: float | None = None
    eta: int | None = None
    elapsed: float | None = None
    fragment_index: int | None = None
    fragment_count: int | None = None
    filename: str | None = None
    format_id: str | None = None
    ext: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """The one error envelope (SPEC §10)."""

    error: ErrorBody


class JobModel(OpenModel):
    """A job as returned by the REST API (SPEC §6)."""

    job_id: str
    url: str
    status: JobStatus
    options: dict[str, Any] = Field(
        default_factory=dict,
        description="The **resolved** options, not the ones sent (SPEC §6).",
    )
    video: dict[str, Any] | None = None
    progress: dict[str, Any] | None = None
    #: The job's own output directory, for "reveal in folder" (SPEC §4.5).
    directory: str | None = None
    files: list[FileModel] = Field(default_factory=list)
    error: dict[str, Any] | None = None
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    elapsed: float | None = None
    ws_url: str | None = None


class JobListResponse(BaseModel):
    jobs: list[JobModel]
    count: int
    total: int


class BinaryModel(OpenModel):
    path: str | None = None
    source: str | None = None
    version: str | None = None
    available: bool = False


class HealthResponse(OpenModel):
    """Self-describing capabilities (SPEC §6 principle, §8)."""

    status: str
    service: str = "inferno-service"
    product: str = "inferno"
    version: str
    yt_dlp_version: str | None = None
    python_version: str | None = None
    ffmpeg: BinaryModel
    ffprobe: BinaryModel
    js_runtime: dict[str, Any]
    cookies: bool = False
    po_token_provider: bool = False
    max_concurrent: int = 2
    jobs: dict[str, int] = Field(default_factory=dict)
    websocket_clients: int = 0
    limits: dict[str, Any] = Field(default_factory=dict)
    features: dict[str, bool] = Field(default_factory=dict)


class SettingsPatch(StrictModel):
    """Body for ``PATCH /api/v1/settings``.

    Partial by design: send only what changed. A ``null`` value clears the
    stored override so the setting falls back to its default.
    """

    values: dict[str, Any] = Field(
        default_factory=dict,
        description="Dotted setting keys to change, e.g. {'downloads.max_concurrent': 4}.",
    )
    reset: list[str] | None = Field(
        None,
        description="Keys to clear entirely. Pass an empty list to reset everything.",
    )


class SettingDescriptor(OpenModel):
    """One row of the settings schema, annotated with its live state."""

    key: str
    type: str
    default: Any = None
    value: Any = None
    group: str
    label: str
    description: str
    scope: str
    env: str | None = None
    runtime: bool = True
    secret: bool = False
    nullable: bool = False
    source: str = "default"
    locked_by_env: bool = False


class SettingsResponse(OpenModel):
    """Everything a settings UI needs in one round trip."""

    values: dict[str, Any] = Field(default_factory=dict)
    download_defaults: dict[str, Any] = Field(default_factory=dict)
    schema_: list[SettingDescriptor] = Field(default_factory=list, alias="schema")
    groups: list[dict[str, Any]] = Field(default_factory=list)
    config_file: str | None = None
    schema_version: int = 1
    restart_required: list[str] = Field(default_factory=list)
    changed: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class InfoResponse(OpenModel):
    """Normalised metadata for a URL."""

    url: str
    cached: bool = False
    video: dict[str, Any] | None = None
    playlist: dict[str, Any] | None = None


class FormatsResponse(OpenModel):
    url: str
    id: str | None = None
    title: str | None = None
    duration: float | None = None
    formats: list[dict[str, Any]] = Field(default_factory=list)


class SubtitlesResponse(OpenModel):
    url: str
    id: str | None = None
    title: str | None = None
    subtitles: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    automatic_captions: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
