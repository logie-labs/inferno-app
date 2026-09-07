//! The local download library.
//!
//! A SQLite record of everything that has ever finished downloading, so
//! history survives a restart (the service's jobs do not - SPEC §2), and so
//! the app can notice when a file has been moved, renamed or deleted and offer
//! to be pointed at it again.

pub mod commands;
mod db;
mod error;
mod signature;

pub use commands::LibraryState;
pub use db::{Deletion, FileState, Library, LibraryEntry, RecordedDownload};
pub use error::{LibraryError, LibraryResult};
