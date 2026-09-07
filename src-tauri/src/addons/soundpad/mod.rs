//! A Rust port of [`soundpad_control`](https://github.com/Ilya-Kokhanovsky/soundpad.py),
//! a client for Soundpad's remote-control named pipe.
//!
//! This module only ports the client itself; it isn't wired up to any Tauri
//! commands yet. [`SoundpadRemoteControl`] is `&mut self`-based and cheap to
//! construct, so the intended integration is to hold one behind a
//! `tauri::State<Mutex<SoundpadRemoteControl>>` and expose thin
//! `#[tauri::command]` wrappers around its methods, using [`SoundpadError`]
//! (already `Serialize`) as the command error type.

pub mod commands;
mod error;
mod remote_control;

pub use commands::SoundpadState;
pub use error::{SoundpadError, SoundpadResult};
pub use remote_control::{PlayStatus, SoundpadRemoteControl};
