//! The library's command surface.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::addons::inferno_service::inferno_existing_ancestor;

use super::db::{Deletion, Library, LibraryEntry, RecordedDownload};
use super::error::{LibraryError, LibraryResult};

pub type LibraryState = Option<Library>;

fn library<'a>(state: &'a State<'_, LibraryState>) -> LibraryResult<&'a Library> {
    state.inner().as_ref().ok_or(LibraryError::Open {
        message: "the library is unavailable for this session".into(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct LibrarySummary {
    pub total: i64,
    pub missing: i64,
}

/// The outcome of locating a file by hand.
///
/// A mismatch is **not** committed. The signature says the chosen file is not
/// the one that was downloaded, and only the person looking at it knows
/// whether that is because they edited it or because they picked the wrong
/// thing - so the candidate comes back for them to decide, and
/// [`library_relocate`] commits it if they say so.
#[derive(Debug, Clone, Serialize)]
pub struct Relocation {
    /// The updated record. Only set once something was actually committed.
    pub entry: Option<LibraryEntry>,
    /// Whether the chosen file matches the original download's signature.
    pub matched: bool,
    /// The picker was dismissed - not an error, and nothing changed.
    pub cancelled: bool,
    /// What they picked, when it did not match and was therefore not applied.
    pub candidate: Option<String>,
}

#[tauri::command]
pub fn library_record(
    state: State<'_, LibraryState>,
    download: RecordedDownload,
) -> LibraryResult<LibraryEntry> {
    library(&state)?.record(download)
}

#[tauri::command]
pub fn library_list(
    state: State<'_, LibraryState>,
    limit: Option<u32>,
) -> LibraryResult<Vec<LibraryEntry>> {
    library(&state)?.list(limit.unwrap_or(500))
}

#[tauri::command]
pub fn library_summary(state: State<'_, LibraryState>) -> LibraryResult<LibrarySummary> {
    let (total, missing) = library(&state)?.counts()?;

    Ok(LibrarySummary { total, missing })
}

/// Re-check one entry. Deliberately an existence check only - this is what
/// runs when a row's menu opens, so it must stay cheap.
#[tauri::command]
pub fn library_verify(
    state: State<'_, LibraryState>,
    id: i64,
) -> LibraryResult<LibraryEntry> {
    library(&state)?.verify(id)
}

/// Forget the download. The file stays on disk.
#[tauri::command]
pub fn library_forget(state: State<'_, LibraryState>, id: i64) -> LibraryResult<()> {
    library(&state)?.forget(id)
}

/// Delete the file as well as the record.
#[tauri::command]
pub fn library_delete(state: State<'_, LibraryState>, id: i64) -> LibraryResult<Deletion> {
    library(&state)?.delete(id)
}

/// The closest folder to `path` that still exists.
///
/// Opening the picker at the file's recorded folder only works while that
/// folder is still there - and if the user deleted or moved the folder rather
/// than the file, it is not, so the picker would open at whatever the OS last
/// remembered, which could be anywhere. Walking up gets as near as the disk
/// allows: with `…/Downloads/Inferno/clip.m4a` gone it opens `Inferno`, and if
/// `Inferno` went too it opens `Downloads`.
///
/// Reuses the same walk as the dialog's "where the trail goes cold" display,
/// so the two always agree about what still exists.
fn nearest_existing_directory(path: Option<&str>) -> Option<PathBuf> {
    let found = PathBuf::from(inferno_existing_ancestor(path?.to_owned())?);

    // The walk stops at the first thing that exists, which is a file when the
    // file is still there; a picker wants the folder around it.
    let directory = if found.is_dir() {
        found
    } else {
        found.parent()?.to_path_buf()
    };

    directory.is_dir().then_some(directory)
}

/// Ask the user where the file went, then check it is the same one.
///
/// `async` and `spawn_blocking` are both load-bearing. `blocking_pick_file`
/// waits for a modal that the main thread has to pump, so calling it *from*
/// the main thread deadlocks the app - and a synchronous Tauri command is not
/// guaranteed to be off it. An async command runs on the async runtime, and
/// the picker then goes to a dedicated blocking thread, which cannot be the
/// main one either way.
#[tauri::command]
pub async fn library_locate(
    app: AppHandle,
    state: State<'_, LibraryState>,
    id: i64,
) -> LibraryResult<Relocation> {
    // Read what the picker needs before crossing the thread boundary; the
    // library itself is not moved.
    let entry = library(&state)?.get(id)?;
    // Start the picker as close to the file as the disk still allows.
    let directory = nearest_existing_directory(
        entry.file_path.as_deref().or(entry.directory.as_deref()),
    );
    let file_name = entry.file_name.clone();

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file();

        // Open where the file used to live, rather than wherever the OS last
        // happened to remember.
        if let Some(directory) = directory {
            picker = picker.set_directory(directory);
        }
        if let Some(name) = file_name.as_deref() {
            picker = picker.set_file_name(name);
        }

        picker
            .set_title(format!(
                "Locate {}",
                file_name.as_deref().unwrap_or("the downloaded file")
            ))
            .blocking_pick_file()
    })
    .await
    .map_err(|err| LibraryError::Io {
        message: format!("the file picker could not be opened: {err}"),
    })?;

    let Some(picked) = picked else {
        // Dismissing the picker is an ordinary outcome, not a failure: the
        // entry stays marked missing and the row's menu keeps offering this.
        return Ok(Relocation {
            entry: None,
            matched: false,
            cancelled: true,
            candidate: None,
        });
    };

    let path = picked.into_path().map_err(|err| LibraryError::Io {
        message: format!("that file could not be read: {err}"),
    })?;

    // Compare before committing. A file that does not match is handed back
    // rather than applied, so the choice stays with the person who can tell
    // an edited copy from the wrong file.
    let library = library(&state)?;
    if !library.matches(id, &path)? {
        return Ok(Relocation {
            entry: None,
            matched: false,
            cancelled: false,
            candidate: Some(path.to_string_lossy().into_owned()),
        });
    }

    let (entry, matched) = library.relocate(id, &path)?;

    Ok(Relocation {
        entry: Some(entry),
        matched,
        cancelled: false,
        candidate: None,
    })
}

/// Point a record at a file the user has chosen despite a signature mismatch.
///
/// Separate from [`library_locate`] on purpose: this is the "yes, use it
/// anyway" half, and it only runs because someone said so.
#[tauri::command]
pub fn library_relocate(
    state: State<'_, LibraryState>,
    id: i64,
    path: String,
) -> LibraryResult<LibraryEntry> {
    let (entry, _matched) = library(&state)?.relocate(id, Path::new(&path))?;

    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_opens_at_the_deepest_folder_that_survives() {
        let here = std::env::current_dir().expect("a working directory");

        // The file is gone but its folder is not: open the folder.
        let missing_file = here.join("no-such-file.mp4");
        assert_eq!(
            nearest_existing_directory(Some(&missing_file.to_string_lossy())),
            Some(here.clone())
        );

        // The folder is gone too: climb until something is there.
        let missing_folder = here.join("no-such-folder").join("no-such-file.mp4");
        assert_eq!(
            nearest_existing_directory(Some(&missing_folder.to_string_lossy())),
            Some(here.clone())
        );
    }

    #[test]
    fn an_existing_file_opens_its_own_folder_not_the_file() {
        let here = std::env::current_dir().expect("a working directory");
        let real = here.join("Cargo.toml");
        assert!(real.is_file(), "fixture must exist for this to mean anything");

        assert_eq!(
            nearest_existing_directory(Some(&real.to_string_lossy())),
            Some(here)
        );
    }

    #[test]
    fn nothing_to_open_when_the_whole_path_is_gone() {
        assert!(nearest_existing_directory(Some(r"Z:\gone\also-gone.mp4")).is_none());
        assert!(nearest_existing_directory(None).is_none());
    }
}
