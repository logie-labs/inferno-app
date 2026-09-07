//! Error types returned by [`SoundpadRemoteControl`](super::SoundpadRemoteControl).

use serde::Serialize;
use thiserror::Error;

/// Errors that can occur while talking to Soundpad over its remote-control pipe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(tag = "kind")]
pub enum SoundpadError {
    /// Soundpad's `sp_remote_control` named pipe doesn't exist, meaning Soundpad
    /// isn't running (or was closed mid-session).
    #[error("Soundpad is not launched or the pipe does not exist.")]
    NotLaunched,

    /// Soundpad accepted the connection but rejected the request, returning an
    /// `R-`-prefixed error response.
    #[error("An error occurred while making a request to Soundpad. (Response: {response})")]
    Request { response: String },

    /// The named pipe could not be opened, written to, or read from.
    #[error("Failed to communicate with Soundpad: {message}")]
    Io { message: String },
}

impl From<std::io::Error> for SoundpadError {
    fn from(err: std::io::Error) -> Self {
        SoundpadError::Io {
            message: err.to_string(),
        }
    }
}

/// Convenience alias for results returned by the Soundpad remote control client.
pub type SoundpadResult<T> = Result<T, SoundpadError>;

#[cfg(test)]
mod tests {
    use super::*;

    // These pin down the exact JSON shape the TypeScript side decodes -
    // if this changes, `lib/soundpad.ts`'s `SoundpadError` type must change too.

    #[test]
    fn not_launched_serializes_to_kind_only() {
        let json = serde_json::to_value(SoundpadError::NotLaunched).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "NotLaunched" }));
    }

    #[test]
    fn request_error_serializes_with_flattened_response_field() {
        let err = SoundpadError::Request {
            response: "R-404".to_string(),
        };
        let json = serde_json::to_value(err).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "Request", "response": "R-404" })
        );
    }

    #[test]
    fn io_error_serializes_with_flattened_message_field() {
        let err = SoundpadError::Io {
            message: "broken pipe".to_string(),
        };
        let json = serde_json::to_value(err).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "Io", "message": "broken pipe" })
        );
    }
}
