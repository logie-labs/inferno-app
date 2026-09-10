"""FastAPI surface: REST routes, websocket endpoints, auth, CORS (SPEC §3, §4, §5).

Everything the service can do is here, behind the public API. The bundled CLI
and web client are ordinary consumers of these endpoints with no privileged
path — anything they can do, a third-party tool can do the same way (SPEC §1).
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterator, Literal

from fastapi import Body, Depends, FastAPI, Query, Request, Response, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.websockets import WebSocketDisconnect

from . import PRODUCT_NAME, SERVICE_NAME, __version__, ytdlp
from .binaries import BinaryResolver
from .config import (
    SCHEMA_VERSION,
    Settings,
    SettingsError,
    SettingsStore,
    settings_groups,
)
from .errors import CODE_FOR_STATUS, ErrorCode, ServiceError, error_envelope
from .events import FIREHOSE, Event, EventBus, EventType, Subscription, job_channel
from .extract import Extractor, InfoCache, validate_url
from .jobs import JobManager
from .schemas import (
    DownloadRequest,
    ErrorResponse,
    FormatsResponse,
    HealthResponse,
    InfoRequest,
    InfoResponse,
    JobListResponse,
    JobModel,
    SettingsPatch,
    SettingsResponse,
    SubtitlesResponse,
)

__all__ = ["create_app", "app", "ServiceContext"]

#: Idle seconds before a heartbeat frame, so proxies do not close the socket.
HEARTBEAT_INTERVAL = 25.0

#: Websocket close codes. 1008 is "policy violation"; the 44xx range is ours.
WS_UNAUTHORIZED = 4401
WS_NOT_FOUND = 4404

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_FILE_CHUNK = 64 * 1024

#: A private in-band marker telling a socket's writer loop that it is finished.
#: It never reaches a client and never enters a replay buffer.
_CLOSE_SENTINEL = Event(type="__close__", job_id=None, ts=0.0, seq=-1, data={})

_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ErrorResponse, "description": "Bad request"},
    401: {"model": ErrorResponse, "description": "Missing or invalid API token"},
    404: {"model": ErrorResponse, "description": "Not found"},
    422: {"model": ErrorResponse, "description": "Malformed body or unknown field"},
    502: {"model": ErrorResponse, "description": "Upstream failure"},
    503: {"model": ErrorResponse, "description": "A required binary did not resolve"},
}


class ServiceContext:
    """Everything the app owns, built once and hung off ``app.state``."""

    def __init__(self, store: SettingsStore, vendor_dir: Path | None = None) -> None:
        self.store = store
        settings = store.settings
        self.binaries = BinaryResolver(settings, vendor_dir=vendor_dir)
        self.events = EventBus(
            history=settings.event_history, progress_interval=settings.progress_interval
        )
        self.cache = InfoCache(settings.info_cache_ttl)
        self.extractor = Extractor(settings, self.binaries, self.cache)
        self.jobs = JobManager(settings, self.binaries, self.events)

    @property
    def settings(self) -> Settings:
        """Always the current snapshot, never a stale capture."""
        return self.store.settings

    async def apply_settings(self, changed: frozenset[str]) -> None:
        """Push a new snapshot into every component that holds one.

        Called after the store has already committed the change, so components
        cannot disagree about what the settings are.
        """
        settings = self.store.settings
        self.binaries.apply_settings(settings)
        self.extractor.apply_settings(settings)
        self.events.set_progress_interval(settings.progress_interval)
        await self.jobs.apply_settings(settings)
        if changed:
            self.events.publish(
                EventType.SETTINGS_CHANGED,
                None,
                {
                    "changed": sorted(changed),
                    "values": self.store.values(),
                    "download_defaults": self.store.download_defaults(),
                    "restart_required": self.store.restart_required(changed),
                },
            )


def _context(source: Request | WebSocket) -> ServiceContext:
    return source.app.state.ctx  # type: ignore[no-any-return]


# --- auth -------------------------------------------------------------------


def _supplied_token(source: Request | WebSocket) -> str | None:
    # SPEC §4: the query form exists because browser WebSocket clients cannot
    # set headers, and it is supported on REST too for consistency.
    return source.headers.get("x-api-key") or source.query_params.get("token")


def _token_ok(source: Request | WebSocket, settings: Settings) -> bool:
    if not settings.auth_required:
        return True
    supplied = _supplied_token(source)
    if not supplied:
        return False
    return secrets.compare_digest(supplied, settings.api_token or "")


async def require_auth(request: Request) -> None:
    settings = _context(request).settings
    if not _token_ok(request, settings):
        raise ServiceError(
            ErrorCode.UNAUTHORIZED,
            "A valid API token is required. Send X-API-Key or ?token=.",
        )


# --- helpers ----------------------------------------------------------------


def _ws_base(request: Request) -> str:
    base = str(request.base_url).rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    return base


def _parse_since(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


def _file_iterator(path: Path, start: int, length: int) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(_FILE_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _serve_file(path: Path, request: Request, mime: str | None) -> Response:
    """Serve a file, honouring a single HTTP ``Range`` so clients can resume."""
    size = path.stat().st_size
    media_type = mime or "application/octet-stream"
    disposition = f'attachment; filename="{path.name}"'
    base_headers = {"accept-ranges": "bytes", "content-disposition": disposition}

    raw_range = request.headers.get("range")
    if not raw_range:
        return FileResponse(path, media_type=media_type, headers=base_headers)

    match = _RANGE_RE.match(raw_range.strip())
    unsatisfiable = JSONResponse(
        status_code=416,
        content=error_envelope(
            ErrorCode.INVALID_REQUEST,
            "The requested byte range cannot be satisfied.",
            {"range": raw_range, "size": size},
        ),
        headers={"content-range": f"bytes */{size}", "accept-ranges": "bytes"},
    )
    if match is None:
        return unsatisfiable

    start_raw, end_raw = match.groups()
    if start_raw == "" and end_raw == "":
        return unsatisfiable

    if start_raw == "":
        # Suffix form: the last N bytes.
        suffix = int(end_raw)
        if suffix == 0 or size == 0:
            return unsatisfiable
        start = max(0, size - suffix)
        end = size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1
        if size == 0 or start >= size or end < start:
            return unsatisfiable
        end = min(end, size - 1)

    length = end - start + 1
    headers = {
        **base_headers,
        "content-range": f"bytes {start}-{end}/{size}",
        "content-length": str(length),
    }
    return StreamingResponse(
        _file_iterator(path, start, length),
        status_code=206,
        media_type=media_type,
        headers=headers,
    )


# --- app --------------------------------------------------------------------


def create_app(
    settings: Settings | None = None,
    *,
    vendor_dir: Path | None = None,
    store: SettingsStore | None = None,
) -> FastAPI:
    """Build the application.

    Pass ``store`` for the full layered settings system (what the desktop app
    and ``python -m inferno_service`` use). Pass ``settings`` for a fixed
    snapshot that never persists — the convenient path for tests and embedders.
    """
    if store is None:
        store = (
            SettingsStore.from_settings(settings)
            if settings is not None
            else SettingsStore()
        )
    resolved_settings = store.settings

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        ctx: ServiceContext = application.state.ctx
        await ctx.jobs.start()
        try:
            yield
        finally:
            await ctx.jobs.aclose()
            ctx.events.bind_loop(None)

    application = FastAPI(
        title="Inferno Service",
        version=__version__,
        summary="Inferno's service layer: yt-dlp behind an HTTP + WebSocket API.",
        description=(
            "The service layer of **Inferno**. It runs standalone today and is "
            "designed to be spawned as a sidecar by the Inferno desktop app.\n\n"
            "Every capability is exposed through this API. The bundled CLI and web "
            "client are ordinary consumers of it with no privileged path.\n\n"
            "Clients send **intent** (mode, quality); the server resolves it into "
            "yt-dlp options. Every failure carries a stable `code`. Every websocket "
            "frame shares one envelope and carries a monotonic `seq`, so a client can "
            "reconnect with `?since=<seq>` and miss nothing."
        ),
        lifespan=lifespan,
        openapi_url="/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
    )
    application.state.ctx = ServiceContext(store, vendor_dir=vendor_dir)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved_settings.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["content-range", "accept-ranges", "content-length", "content-disposition"],
    )

    _install_error_handlers(application)
    _install_routes(application)

    # Last, and only when this deployment ships a frontend: a mount at "/"
    # matches anything the routes above did not.
    web_root = _web_root()
    if web_root is not None:
        _install_web_root(application, web_root)

    return application


def _web_root() -> Path | None:
    """The built frontend to serve at ``/``, if this deployment ships one.

    Set ``INFERNO_WEB_ROOT`` to the directory holding a built Inferno frontend
    (``next build`` with ``output: "export"``) and the service serves it
    alongside the API, on one origin and one port. That is what the container
    image does.

    Unset — every desktop install, every existing deployment — nothing here
    changes: the mount is never added and ``/`` keeps serving the bundled test
    client exactly as before. The variable is the whole opt-in.

    Serving the UI from the API's own origin is not a convenience. It is what
    lets the browser build skip CORS entirely and send no token: the frontend
    already resolves its endpoint to ``window.location.origin`` when the Tauri
    bridge is absent, so same-origin is the configuration it expects.
    """
    raw = os.environ.get("INFERNO_WEB_ROOT", "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser()
    return root if root.is_dir() else None


def _install_web_root(application: FastAPI, root: Path) -> None:
    """Mount the built frontend last, so it can never shadow the API.

    Starlette matches routes in registration order and a mount at ``/`` swallows
    everything below it, so this has to run after `_install_routes` — which is
    the only reason it is a separate function rather than another block in the
    factory. ``/api/v1/...``, ``/health``, ``/docs``, ``/openapi.json`` and the
    websockets are all registered by then and keep winning; the mount picks up
    what is left, which is exactly the static bundle (``/_next/...`` and the
    page itself).

    ``html=True`` gives directory requests their ``index.html``, which is how a
    statically exported Next route like ``/soundpad-test/`` resolves.

    ``/`` itself is not handled here — `client_page` already owns that exact
    path and was registered first, so it decides between the bundled test client
    and this bundle. One route, one decision.
    """
    application.mount("/", StaticFiles(directory=root, html=True), name="web")


def _install_error_handlers(application: FastAPI) -> None:
    @application.exception_handler(ServiceError)
    async def _service_error(request: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.envelope())

    @application.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # SPEC §4: a typo in someone's integration fails loudly at the boundary.
        errors = [
            {
                "location": list(error.get("loc", ())),
                "message": error.get("msg"),
                "type": error.get("type"),
            }
            for error in exc.errors()
        ]
        unknown = [e for e in errors if e["type"] == "extra_forbidden"]
        message = (
            f"Unknown request field(s): {', '.join(str(e['location'][-1]) for e in unknown)}."
            if unknown
            else "The request body or query string is invalid."
        )
        return JSONResponse(
            status_code=422,
            content=error_envelope(ErrorCode.INVALID_REQUEST, message, {"errors": errors}),
        )

    @application.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # SPEC §10 says one envelope, always — including for failures the
        # framework raises before any route runs, such as an unknown path.
        return JSONResponse(
            status_code=exc.status_code,
            content=error_envelope(
                CODE_FOR_STATUS.get(exc.status_code, ErrorCode.HTTP_ERROR),
                str(exc.detail),
            ),
            headers=getattr(exc, "headers", None),
        )

    @application.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content=error_envelope(
                ErrorCode.INTERNAL_ERROR,
                "The server hit an unhandled error.",
                {"reason": str(exc), "type": type(exc).__name__},
            ),
        )


def _install_routes(application: FastAPI) -> None:
    guarded = [Depends(require_auth)]

    # --- health ------------------------------------------------------------

    @application.get(
        "/health",
        response_model=HealthResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["service"],
        summary="Capabilities, versions and job counts",
    )
    async def health(request: Request) -> dict[str, Any]:
        ctx = _context(request)
        settings = ctx.settings
        binaries = ctx.binaries.health_dict()
        return {
            "status": "ok",
            # Names the component, so a client that finds the port knows what
            # answered — the desktop app is not the only thing that may probe it.
            "service": SERVICE_NAME,
            "product": PRODUCT_NAME,
            "version": __version__,
            "yt_dlp_version": ytdlp.ytdlp_version(),
            "python_version": platform.python_version(),
            **binaries,
            "cookies": bool(settings.cookies_from_browser or settings.cookie_file),
            "po_token_provider": False,
            "max_concurrent": settings.max_concurrent,
            "jobs": ctx.jobs.counts(),
            "websocket_clients": ctx.events.subscriber_count,
            "limits": {
                "event_history": settings.event_history,
                "progress_interval": settings.progress_interval,
                "info_cache_ttl": settings.info_cache_ttl,
                "job_ttl": settings.job_ttl,
                "http_chunk_size": settings.http_chunk_size,
            },
            "features": {
                "merge": ctx.binaries.ffmpeg.available and ctx.binaries.ffprobe.available,
                "audio_extraction": ctx.binaries.ffmpeg.available,
                "embed_metadata": ctx.binaries.ffmpeg.available,
                "embed_thumbnail": ctx.binaries.ffmpeg.available,
                "embed_subtitles": ctx.binaries.ffmpeg.available,
                "js_challenges": ctx.binaries.js_runtime.available,
                "serve_files": settings.serve_files,
                "auth": settings.auth_required,
            },
            "download_dir": str(settings.resolved_download_dir()),
            "event_seq": ctx.events.current_seq,
        }

    # --- settings ----------------------------------------------------------

    def _settings_payload(
        ctx: ServiceContext, changed: frozenset[str] | tuple[str, ...] = ()
    ) -> dict[str, Any]:
        store = ctx.store
        return {
            "values": store.values(),
            "download_defaults": store.download_defaults(),
            "schema": store.describe(),
            "groups": settings_groups(),
            "config_file": str(store.config_file),
            "schema_version": SCHEMA_VERSION,
            "restart_required": store.restart_required(changed),
            "changed": sorted(changed),
            "errors": list(store.load_errors),
        }

    @application.get(
        "/api/v1/settings",
        response_model=SettingsResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["settings"],
        summary="Effective settings, the schema behind them, and where each came from",
    )
    async def get_settings(request: Request) -> dict[str, Any]:
        return _settings_payload(_context(request))

    @application.patch(
        "/api/v1/settings",
        response_model=SettingsResponse,
        dependencies=guarded,
        responses={**_ERROR_RESPONSES, 409: {"model": ErrorResponse, "description": "Pinned by env"}},
        tags=["settings"],
        summary="Change settings; applies live where it can",
    )
    async def patch_settings(
        request: Request, body: SettingsPatch = Body(...)
    ) -> dict[str, Any]:
        ctx = _context(request)
        changed: frozenset[str] = frozenset()
        try:
            if body.reset is not None:
                changed |= ctx.store.reset(body.reset or None)
            if body.values:
                changed |= ctx.store.update(body.values)
        except SettingsError as exc:
            locked = "pinned by the" in exc.reason
            raise ServiceError(
                ErrorCode.SETTING_LOCKED if locked else ErrorCode.INVALID_REQUEST,
                str(exc),
                {"key": exc.key, "reason": exc.reason},
            ) from exc

        await ctx.apply_settings(changed)
        return _settings_payload(ctx, changed)

    # --- metadata ----------------------------------------------------------

    @application.get(
        "/api/v1/info",
        response_model=InfoResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["metadata"],
        summary="Normalised metadata for a URL",
    )
    async def info_get(
        request: Request,
        url: str = Query(..., description="The page URL."),
        playlist: bool = Query(False),
        refresh: bool = Query(False),
    ) -> dict[str, Any]:
        return await _context(request).extractor.info(
            validate_url(url), playlist=playlist, refresh=refresh
        )

    @application.post(
        "/api/v1/info",
        response_model=InfoResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["metadata"],
        summary="Normalised metadata for a URL",
    )
    async def info_post(request: Request, body: InfoRequest = Body(...)) -> dict[str, Any]:
        return await _context(request).extractor.info(
            validate_url(body.url), playlist=body.playlist, refresh=body.refresh
        )

    @application.get(
        "/api/v1/formats",
        response_model=FormatsResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["metadata"],
        summary="Format table only, for a quality picker",
    )
    async def formats(
        request: Request,
        url: str = Query(...),
        refresh: bool = Query(False),
    ) -> dict[str, Any]:
        payload = await _context(request).extractor.info(validate_url(url), refresh=refresh)
        video = payload.get("video") or {}
        if not video:
            raise ServiceError(
                ErrorCode.INVALID_URL,
                "That URL resolves to a playlist, which has no format table.",
                {"url": url},
            )
        return {
            "url": payload["url"],
            "id": video.get("id"),
            "title": video.get("title"),
            "duration": video.get("duration"),
            "formats": video.get("formats", []),
            "cached": payload.get("cached", False),
        }

    @application.get(
        "/api/v1/subtitles",
        response_model=SubtitlesResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["metadata"],
        summary="Caption track listing; fetches nothing",
    )
    async def subtitles(
        request: Request,
        url: str = Query(...),
        refresh: bool = Query(False),
    ) -> dict[str, Any]:
        payload = await _context(request).extractor.info(validate_url(url), refresh=refresh)
        video = payload.get("video") or {}
        if not video:
            raise ServiceError(
                ErrorCode.INVALID_URL,
                "That URL resolves to a playlist, which has no caption tracks.",
                {"url": url},
            )
        return {
            "url": payload["url"],
            "id": video.get("id"),
            "title": video.get("title"),
            "subtitles": video.get("subtitles", {}),
            "automatic_captions": video.get("automatic_captions", {}),
            "cached": payload.get("cached", False),
        }

    # --- downloads ---------------------------------------------------------

    @application.post(
        "/api/v1/downloads",
        response_model=JobModel,
        status_code=202,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["downloads"],
        summary="Queue a job; returns immediately with the job object and a ws_url",
    )
    async def create_download(
        request: Request, body: DownloadRequest = Body(...)
    ) -> dict[str, Any]:
        ctx = _context(request)
        # Fields the client omitted fall back to the user's saved preferences,
        # so a caller can post just a URL and still get their chosen quality.
        job = ctx.jobs.create(body, defaults=ctx.store.download_defaults())
        return job.to_dict(ws_base=_ws_base(request))

    @application.get(
        "/api/v1/downloads",
        response_model=JobListResponse,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["downloads"],
        summary="List jobs",
    )
    async def list_downloads(
        request: Request,
        status: Literal[
            "queued",
            "extracting",
            "downloading",
            "postprocessing",
            "completed",
            "failed",
            "cancelled",
        ]
        | None = Query(None),
        limit: int | None = Query(None, ge=0, le=1000),
    ) -> dict[str, Any]:
        ctx = _context(request)
        jobs, total = ctx.jobs.list(status=status, limit=limit)
        ws_base = _ws_base(request)
        payload = [job.to_dict(ws_base=ws_base) for job in jobs]
        return {"jobs": payload, "count": len(payload), "total": total}

    @application.get(
        "/api/v1/downloads/{job_id}",
        response_model=JobModel,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["downloads"],
        summary="One job",
    )
    async def get_download(request: Request, job_id: str) -> dict[str, Any]:
        ctx = _context(request)
        return ctx.jobs.get(job_id).to_dict(ws_base=_ws_base(request))

    @application.post(
        "/api/v1/downloads/{job_id}/cancel",
        response_model=JobModel,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["downloads"],
        summary="Cancel a running or queued job",
    )
    async def cancel_download(request: Request, job_id: str) -> dict[str, Any]:
        ctx = _context(request)
        job = await ctx.jobs.cancel(job_id)
        return job.to_dict(ws_base=_ws_base(request))

    @application.delete(
        "/api/v1/downloads/{job_id}",
        status_code=204,
        dependencies=guarded,
        responses=_ERROR_RESPONSES,
        tags=["downloads"],
        summary="Cancel and remove a job, and its files unless keep_files",
    )
    async def delete_download(
        request: Request, job_id: str, keep_files: bool = Query(False)
    ) -> Response:
        ctx = _context(request)
        await ctx.jobs.delete(job_id, keep_files=keep_files)
        return Response(status_code=204)

    @application.get(
        "/api/v1/downloads/{job_id}/files/{name:path}",
        dependencies=guarded,
        responses={
            **_ERROR_RESPONSES,
            200: {"content": {"application/octet-stream": {}}, "description": "The file"},
            206: {"content": {"application/octet-stream": {}}, "description": "A byte range"},
            416: {"model": ErrorResponse, "description": "Unsatisfiable Range"},
        },
        tags=["downloads"],
        summary="Fetch a finished file (supports HTTP Range)",
    )
    async def get_file(request: Request, job_id: str, name: str) -> Response:
        ctx = _context(request)
        if not ctx.settings.serve_files:
            raise ServiceError(
                ErrorCode.FILE_SERVING_DISABLED,
                "File serving is disabled on this server (SERVE_FILES=false).",
            )
        job = ctx.jobs.get(job_id)
        path = ctx.jobs.resolve_file(job, name)
        mime = next((f.get("mime") for f in job.files if f.get("name") == name), None)
        return _serve_file(path, request, mime)

    # --- the minimal test client (an ordinary API consumer) ----------------

    @application.get("/", include_in_schema=False)
    @application.get("/client", include_in_schema=False)
    async def client_page(request: Request) -> Response:
        # A deployment that ships a built frontend serves that at `/` instead.
        # `/client` still reaches the bundled test client either way, which is
        # what makes it useful for telling "the API is fine, the UI is broken"
        # apart from "the service is down" without changing the deployment.
        root = _web_root()
        if root is not None and request.url.path == "/":
            page = root / "index.html"
            if page.is_file():
                return FileResponse(
                    page,
                    media_type="text/html",
                    headers={
                        "cache-control": "no-store, must-revalidate",
                        "pragma": "no-cache",
                    },
                )

        page = Path(__file__).resolve().parent / "clients" / "client.html"
        if not page.is_file():  # pragma: no cover - only if the file is missing
            return JSONResponse(
                status_code=404,
                content=error_envelope(ErrorCode.FILE_NOT_FOUND, "client.html is not installed."),
            )
        # The page changes with the service, and a browser holding a stale copy
        # looks exactly like a bug that was never fixed. Never cache it.
        return FileResponse(
            page,
            media_type="text/html",
            headers={"cache-control": "no-store, must-revalidate", "pragma": "no-cache"},
        )

    _install_websockets(application)


# --- websockets -------------------------------------------------------------


def _install_websockets(application: FastAPI) -> None:
    @application.websocket("/ws/downloads/{job_id}")
    async def ws_job(websocket: WebSocket, job_id: str) -> None:
        ctx = _context(websocket)
        if not _token_ok(websocket, ctx.settings):
            await websocket.close(code=WS_UNAUTHORIZED, reason="unauthorized")
            return
        try:
            job = ctx.jobs.get(job_id)
        except ServiceError:
            await websocket.close(code=WS_NOT_FOUND, reason="job_not_found")
            return

        since = _parse_since(websocket.query_params.get("since"))
        subscription = ctx.events.subscribe(job_channel(job_id), since)
        await websocket.accept()
        try:
            first = ctx.events.make_frame(
                EventType.JOB_SNAPSHOT,
                job_id,
                {"job": job.snapshot(), "replay_truncated": subscription.replay_truncated},
            )
            await websocket.send_json(first.to_dict())
            await _replay_then_stream(websocket, subscription, ctx, job_id)
        except WebSocketDisconnect:
            pass
        finally:
            ctx.events.unsubscribe(subscription)

    @application.websocket("/ws/events")
    async def ws_events(websocket: WebSocket) -> None:
        ctx = _context(websocket)
        if not _token_ok(websocket, ctx.settings):
            await websocket.close(code=WS_UNAUTHORIZED, reason="unauthorized")
            return

        since = _parse_since(websocket.query_params.get("since"))
        subscription = ctx.events.subscribe(FIREHOSE, since)
        await websocket.accept()
        try:
            recent, _ = ctx.jobs.list(limit=20)
            first = ctx.events.make_frame(
                EventType.HELLO,
                None,
                {
                    "service": SERVICE_NAME,
                    "product": PRODUCT_NAME,
                    "version": __version__,
                    "yt_dlp_version": ytdlp.ytdlp_version(),
                    "max_concurrent": ctx.settings.max_concurrent,
                    "event_history": ctx.settings.event_history,
                    "heartbeat_interval": HEARTBEAT_INTERVAL,
                    "capabilities": ctx.binaries.health_dict(),
                    "jobs": [job.to_dict() for job in recent],
                    "replay_truncated": subscription.replay_truncated,
                },
            )
            await websocket.send_json(first.to_dict())
            await _replay_then_stream(websocket, subscription, ctx, None)
        except WebSocketDisconnect:
            pass
        finally:
            ctx.events.unsubscribe(subscription)


async def _replay_then_stream(
    websocket: WebSocket,
    subscription: Subscription,
    ctx: ServiceContext,
    job_id: str | None,
) -> None:
    """Replay buffered events newer than ``since``, then stream live (SPEC §5)."""
    for event in subscription.replay:
        await websocket.send_json(event.to_dict())

    stop = asyncio.Event()

    async def receiver() -> None:
        # Client to server is deliberately minimal: ping -> pong. REST is the
        # canonical path for actions, so there is exactly one way to cancel.
        try:
            while True:
                message = await websocket.receive_json()
                if isinstance(message, dict) and message.get("type") == "ping":
                    subscription.offer(ctx.events.make_frame(EventType.PONG, job_id))
        except Exception:  # noqa: BLE001 - any receive failure ends the socket
            pass
        finally:
            stop.set()
            subscription.offer(_CLOSE_SENTINEL)

    reader = asyncio.create_task(receiver())
    try:
        while not stop.is_set():
            event = await subscription.get(timeout=HEARTBEAT_INTERVAL)
            if event is _CLOSE_SENTINEL or stop.is_set():
                break
            frame = (
                event.to_dict()
                if event is not None
                else ctx.events.make_frame(EventType.HEARTBEAT, job_id).to_dict()
            )
            await websocket.send_json(frame)
    finally:
        reader.cancel()


#: The module-level app, for ``uvicorn inferno_service.main:app``.
app = create_app()
