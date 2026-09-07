# PyInstaller spec for the bundled service. Built by `npm run build:service`.
#
# Onedir, not onefile: onefile re-extracts ~40 MB to a temp directory on *every*
# launch, costing one to three seconds of startup. The app already ships a
# resource directory for ffmpeg, so a folder costs no extra machinery.
#
# The vendored binaries are deliberately NOT collected here. They ship as a
# separate Tauri resource under their plain names, because yt-dlp derives
# ffprobe's location from ffmpeg's directory - anything that renames the pair
# leaves ffprobe unfindable and every merge fails (SPEC §8).

from PyInstaller.utils.hooks import collect_all

# yt-dlp imports its extractors by name at runtime; the bytecode analysis sees
# none of them, so the whole package is collected.
ytdlp_datas, ytdlp_binaries, ytdlp_hidden = collect_all("yt_dlp")

# The service itself needs collecting for the same reason: __main__ hands
# uvicorn the *string* "inferno_service.main:app", so nothing statically
# imports the app module and the analysis would leave it out entirely.
service_datas, service_binaries, service_hidden = collect_all("inferno_service")

# yt-dlp reaches mutagen through `..dependencies`, which swallows an ImportError
# and leaves the name None - so a bundle that missed it does not fail to start,
# it just quietly loses cover-art support and falls back to an ffmpeg remux that
# breaks on any m4a with chapters. Collected explicitly rather than left to the
# analysis, because that failure only ever shows up in a packaged build.
mutagen_datas, mutagen_binaries, mutagen_hidden = collect_all("mutagen")

a = Analysis(
    # launcher.py, not inferno_service/__main__.py: PyInstaller runs its entry
    # script as a bare `__main__` with no parent package, and __main__.py is
    # full of relative imports that need one.
    ["launcher.py"],
    pathex=["."],
    binaries=[*ytdlp_binaries, *service_binaries, *mutagen_binaries],
    datas=[
        # The bundled web client is served from the package at runtime.
        ("inferno_service/clients/client.html", "inferno_service/clients"),
        *ytdlp_datas,
        *service_datas,
        *mutagen_datas,
    ],
    hiddenimports=[
        # uvicorn resolves these by string at runtime, so the analysis cannot
        # see them either.
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan.on",
        *ytdlp_hidden,
        *service_hidden,
        *mutagen_hidden,
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="inferno-service",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Console subsystem on purpose: the app reads this process's stderr to
    # explain a failed start. The parent spawns it with CREATE_NO_WINDOW, so
    # nothing is ever shown.
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="inferno-service",
)
