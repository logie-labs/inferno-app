//! Supervision for `inferno-service`, the Python process that actually talks to
//! yt-dlp.
//!
//! The app gets no privileged path to it. Everything the UI does — queueing a
//! download, listing jobs, reading settings, streaming progress — is an
//! ordinary HTTP or WebSocket call to the same public API the CLI and the
//! bundled web client use. This module only starts the process, waits for it to
//! answer, and makes sure it dies when the app does.

pub mod commands;
pub mod directory;
mod error;
pub mod files;
mod process;

pub use commands::{Endpoint, ServiceState, Status};
pub use error::{ServiceError, ServiceResult};
pub use directory::{inferno_check_directory, inferno_pick_directory};
pub use files::{
    inferno_existing_ancestor, inferno_open_path, inferno_open_url, inferno_place_download,
    inferno_reveal_path,
};
pub use process::{launch, ServiceHandle};
