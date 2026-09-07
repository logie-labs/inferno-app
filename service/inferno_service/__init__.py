"""Inferno service — a local service wrapping yt-dlp behind an HTTP + WebSocket API.

Inferno is the whole stack. This package is its service layer: it runs
standalone today and is designed to be spawned as a sidecar process by the
Inferno desktop app later, which is why every capability is reachable over the
public API and nothing is hidden behind an in-process shortcut.
"""

__version__ = "1.0.0"

#: Identifies this component in ``/health`` and in the websocket ``hello`` frame,
#: so a client that finds the port knows what answered.
SERVICE_NAME = "inferno-service"

#: The product the service belongs to.
PRODUCT_NAME = "inferno"

__all__ = ["__version__", "SERVICE_NAME", "PRODUCT_NAME"]
