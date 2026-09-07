//! Reading and writing a settings file the user chose.
//!
//! Only the file half lives here. The schema, the defaults and the merge stay
//! in TypeScript, which is where every other part of settings already is -
//! teaching Rust the shape as well would mean two definitions to keep in step
//! and a Rust release needed to add a setting. So the frontend hands over a
//! finished JSON document, and this decides where it goes.
//!
//! The picker is the reason this cannot be done from the webview: choosing a
//! path is a native dialog, and writing outside the app's own sandbox is a
//! native capability.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::addons::inferno_service::{ServiceError, ServiceResult};

/// What came back from a picker, including the ordinary "they changed their
/// mind" outcome - which is not an error and must not be reported as one.
#[derive(Debug, Clone, Serialize)]
pub struct Transfer {
    pub cancelled: bool,
    /// Where it went, or came from. Shown so the toast can name the file.
    pub path: Option<String>,
    /// Import only: the document itself, for the frontend to validate.
    pub contents: Option<String>,
}

impl Transfer {
    fn cancelled() -> Self {
        Self { cancelled: true, path: None, contents: None }
    }
}

fn default_directory(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .ok()
}

/// Write the settings document to a file the user picks.
///
/// `async` plus `spawn_blocking` for the same reason as the library's locate
/// command: `blocking_save_file` waits on a modal the main thread has to pump,
/// so running it there deadlocks the app.
#[tauri::command]
pub async fn settings_export(
    app: AppHandle,
    contents: String,
    suggested_name: String,
) -> ServiceResult<Transfer> {
    let directory = default_directory(&app);

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file();
        if let Some(directory) = directory {
            picker = picker.set_directory(directory);
        }

        picker
            .set_title("Export Inferno settings")
            .set_file_name(&suggested_name)
            .add_filter("JSON", &["json"])
            .blocking_save_file()
    })
    .await
    .map_err(|err| ServiceError::Io {
        message: format!("the save dialog could not be opened: {err}"),
    })?;

    let Some(picked) = picked else {
        return Ok(Transfer::cancelled());
    };

    let path = picked.into_path().map_err(|err| ServiceError::Io {
        message: format!("that location could not be used: {err}"),
    })?;

    std::fs::write(&path, contents).map_err(|err| ServiceError::Io {
        message: format!("could not write {}: {err}", path.display()),
    })?;

    Ok(Transfer {
        cancelled: false,
        path: Some(path.to_string_lossy().into_owned()),
        contents: None,
    })
}

/// Read a settings document the user picks. Parsing is the caller's job.
#[tauri::command]
pub async fn settings_import(app: AppHandle) -> ServiceResult<Transfer> {
    let directory = default_directory(&app);

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file();
        if let Some(directory) = directory {
            picker = picker.set_directory(directory);
        }

        picker
            .set_title("Import Inferno settings")
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
    })
    .await
    .map_err(|err| ServiceError::Io {
        message: format!("the file picker could not be opened: {err}"),
    })?;

    let Some(picked) = picked else {
        return Ok(Transfer::cancelled());
    };

    let path = picked.into_path().map_err(|err| ServiceError::Io {
        message: format!("that file could not be read: {err}"),
    })?;

    let contents = std::fs::read_to_string(&path).map_err(|err| ServiceError::Io {
        message: format!("could not read {}: {err}", path.display()),
    })?;

    Ok(Transfer {
        cancelled: false,
        path: Some(path.to_string_lossy().into_owned()),
        contents: Some(contents),
    })
}
