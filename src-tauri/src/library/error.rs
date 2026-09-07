//! Errors from the local library database.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(tag = "kind")]
pub enum LibraryError {
    #[error("The download library could not be opened: {message}")]
    Open { message: String },

    #[error("The download library could not be read or written: {message}")]
    Query { message: String },

    #[error("There is no record of that download.")]
    NotFound,

    #[error("{message}")]
    Io { message: String },
}

impl From<rusqlite::Error> for LibraryError {
    fn from(err: rusqlite::Error) -> Self {
        LibraryError::Query {
            message: err.to_string(),
        }
    }
}

pub type LibraryResult<T> = Result<T, LibraryError>;
