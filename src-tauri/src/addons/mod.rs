//! Optional, self-contained integrations that sit alongside the app's core
//! YouTube-downloader functionality. Each addon lives in its own submodule
//! and is designed to be wired into Tauri commands independently.

/// Supervision for the bundled `inferno-service` process, which owns every
/// yt-dlp interaction and exposes it over HTTP + WebSocket.
pub mod inferno_service;

/// Soundpad remote-control client. Windows-only: Soundpad itself is a
/// Windows application and its remote control API is a Windows named pipe.
#[cfg(windows)]
pub mod soundpad;
pub mod spotify;
