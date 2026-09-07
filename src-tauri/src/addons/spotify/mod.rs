//! Delivering finished audio into Spotify's local-files folders.
//!
//! Spotify will play files it finds in folders the user has added under
//! Settings > Local Files, so an audio download can be dropped straight into a
//! library without any API, account linking or upload. What it cannot do is
//! tell anyone where those folders are - hence `probe`, which works it out
//! from the per-account state Spotify leaves on disk.

pub mod commands;
pub mod probe;
pub mod tracks;

pub use commands::{spotify_place, spotify_survey};
pub use probe::{SpotifyAccount, SpotifyInstallation, SpotifyKind};
