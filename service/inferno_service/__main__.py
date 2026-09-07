"""Run the service: python -m inferno_service

Also the shape a Tauri sidecar would use: one process, one port, everything
else discoverable from /health.

Kept ASCII-only because argparse prints this docstring to the console.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Sequence


def _check(args: argparse.Namespace) -> int:
    """Resolve binaries and print what won, without starting a server."""
    from .binaries import BinaryResolver
    from .config import Settings
    from .ytdlp import ytdlp_version

    settings = Settings.from_env()
    resolver = BinaryResolver(settings)
    report = {
        "yt_dlp_version": ytdlp_version(),
        **resolver.health_dict(),
        "download_dir": str(settings.resolved_download_dir()),
        "max_concurrent": settings.max_concurrent,
        "cookies": bool(settings.cookies_from_browser or settings.cookie_file),
        "auth": settings.auth_required,
    }
    print(json.dumps(report, indent=2))
    missing = [
        name
        for name, info in (
            ("ffmpeg", resolver.ffmpeg),
            ("ffprobe", resolver.ffprobe),
            ("js_runtime", resolver.js_runtime),
        )
        if not info.available
    ]
    if missing:
        print(f"\nUnresolved: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inferno-service", description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log-level", default="info")
    parser.add_argument("--reload", action="store_true", help="Developer autoreload.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Print resolved binaries and capabilities, then exit.",
    )
    parser.add_argument(
        "--config-file",
        default=None,
        help="Where settings persist. Overrides INFERNO_CONFIG_FILE.",
    )
    parser.add_argument(
        "--emit-typescript",
        nargs="?",
        const="-",
        metavar="PATH",
        help="Write the settings schema as TypeScript for the desktop app, then exit.",
    )
    args = parser.parse_args(argv)

    if args.emit_typescript:
        from .config import emit_typescript

        source = emit_typescript()
        if args.emit_typescript == "-":
            sys.stdout.write(source)
        else:
            target = Path(args.emit_typescript)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source, encoding="utf-8")
            print(f"wrote {target} ({len(source.splitlines())} lines)")
        return 0

    if args.check:
        return _check(args)

    if args.config_file:
        os.environ["INFERNO_CONFIG_FILE"] = args.config_file

    import uvicorn

    uvicorn.run(
        "inferno_service.main:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
