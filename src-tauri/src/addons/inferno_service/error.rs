//! Error types for spawning and supervising the bundled `inferno-service`.

use serde::Serialize;
use thiserror::Error;

/// Everything that can go wrong between "the app started" and "the service
/// answers `/health`". These surface in the UI verbatim, so each one names the
/// thing a person could actually act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(tag = "kind")]
pub enum ServiceError {
    /// Neither a bundled service nor a development checkout was found. Always a
    /// packaging mistake — the resource never made it into the bundle.
    #[error("The download service is missing from this installation (looked in {path}).")]
    Missing { path: String },

    /// The executable exists but would not start.
    #[error("The download service could not be started: {message}")]
    Spawn { message: String },

    /// The process started but never served `/health`. `detail` carries the
    /// child's stderr, which is where the real reason lives.
    #[error("The download service did not start within {seconds}s. {detail}")]
    NotReady { seconds: u64, detail: String },

    /// The service exited on its own after coming up.
    #[error("The download service stopped unexpectedly ({status}).")]
    Exited { status: String },

    #[error("{message}")]
    Io { message: String },
}

impl From<std::io::Error> for ServiceError {
    fn from(err: std::io::Error) -> Self {
        ServiceError::Io {
            message: err.to_string(),
        }
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;
