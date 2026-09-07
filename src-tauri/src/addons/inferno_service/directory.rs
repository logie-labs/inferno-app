//! Judging a folder someone has typed, before anything is downloaded into it.
//!
//! A path typed by hand can be wrong in several different ways, and they call
//! for completely different responses: a folder that does not exist yet is
//! fine and will simply be created, whereas one inside a read-only location is
//! a dead end that has to be said out loud *now* - the alternative is a
//! download that runs for two minutes and then fails at the last step.
//!
//! Writability is tested by writing. There is no reliable way to ask Windows
//! whether a directory is writable - permissions, ownership, inherited denials,
//! read-only volumes and virtualised locations all interact - so a probe file
//! is created and immediately removed. It is the only answer that is actually
//! true at the moment it is given.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use super::{ServiceError, ServiceResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryStatus {
    /// There, a directory, and writable.
    Ok,
    /// Not there yet, but the nearest existing parent will take it.
    WillCreate,
    /// The path names a file, so nothing can be written *into* it.
    NotADirectory,
    /// It exists but will not accept a file.
    Unwritable,
    /// Nothing above it exists either - usually a drive that is not mounted.
    NoParent,
    /// Empty, relative, or otherwise not a location.
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirectoryCheck {
    pub status: DirectoryStatus,
    /// What to tell the person, already phrased for them.
    pub message: String,
    /// The deepest part that does exist - what would be created inside.
    pub existing_parent: Option<String>,
}

fn describe(status: DirectoryStatus, message: impl Into<String>) -> DirectoryCheck {
    DirectoryCheck {
        status,
        message: message.into(),
        existing_parent: None,
    }
}

/// Can a file actually be created here? Written, then removed.
fn writable(directory: &Path) -> bool {
    // A name nothing else would pick, so a collision cannot make this lie.
    let probe = directory.join(format!(
        ".inferno-write-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The deepest ancestor of `path` that exists.
fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut candidate = Some(path);

    while let Some(current) = candidate {
        if current.as_os_str().is_empty() {
            return None;
        }
        if current.exists() {
            return Some(current.to_path_buf());
        }
        candidate = current.parent();
    }

    None
}

/// Judge a folder for a download destination.
///
/// `async` plus `spawn_blocking`, because the answer is arrived at by
/// *writing*: a probe file, created and removed. A sync command runs on the
/// main thread, so on a synced or networked folder that write stalls the
/// window - and this fires the moment a screen carrying a folder field opens,
/// which is exactly when a transition is trying to play.
#[tauri::command]
pub async fn inferno_check_directory(path: String) -> DirectoryCheck {
    tauri::async_runtime::spawn_blocking(move || check_directory(path))
        .await
        .unwrap_or_else(|_| {
            describe(DirectoryStatus::Invalid, "That folder could not be checked.")
        })
}

fn check_directory(path: String) -> DirectoryCheck {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return describe(DirectoryStatus::Invalid, "Enter a folder.");
    }

    let candidate = Path::new(trimmed);

    // A relative path would be resolved against the service's working
    // directory, which is not somewhere anyone means.
    if !candidate.is_absolute() {
        return describe(
            DirectoryStatus::Invalid,
            "Use a full path, starting with a drive letter.",
        );
    }

    if candidate.is_file() {
        return describe(
            DirectoryStatus::NotADirectory,
            "That is a file, not a folder.",
        );
    }

    if candidate.is_dir() {
        return if writable(candidate) {
            describe(DirectoryStatus::Ok, "Downloads will be saved here.")
        } else {
            describe(
                DirectoryStatus::Unwritable,
                "This folder cannot be written to. Check its permissions, or pick another.",
            )
        };
    }

    // Not there. Whether that is fine depends entirely on what is above it.
    let Some(parent) = existing_ancestor(candidate) else {
        return describe(
            DirectoryStatus::NoParent,
            "None of this path exists. Is the drive connected?",
        );
    };

    if parent.is_file() {
        return describe(
            DirectoryStatus::NotADirectory,
            format!("{} is a file, so nothing can be created inside it.", parent.display()),
        );
    }

    if !writable(&parent) {
        return DirectoryCheck {
            status: DirectoryStatus::Unwritable,
            message: format!(
                "{} cannot be written to, so this folder cannot be created.",
                parent.display()
            ),
            existing_parent: Some(parent.to_string_lossy().into_owned()),
        };
    }

    DirectoryCheck {
        status: DirectoryStatus::WillCreate,
        message: "This folder does not exist yet. It will be created.".into(),
        existing_parent: Some(parent.to_string_lossy().into_owned()),
    }
}

/// Ask for a folder with the system's own picker.
///
/// A sibling of the check above rather than a reuse of the Spotify one: that
/// picker names itself in its title bar, and being asked to choose a Spotify
/// folder when you are setting the download folder is worse than having two
/// near-identical commands.
///
/// `async` plus `spawn_blocking`, because the dialog is modal and the main
/// thread has to go on pumping messages while it is up.
#[tauri::command]
pub async fn inferno_pick_directory(
    app: tauri::AppHandle,
    start: Option<String>,
) -> ServiceResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose a download folder");

        // Open where the field already points, so choosing a folder next to
        // the current one is not a walk back down the tree. A path that is no
        // longer there is ignored rather than refused.
        if let Some(start) = start
            .as_deref()
            .map(str::trim)
            .filter(|path| Path::new(path).is_dir())
        {
            dialog = dialog.set_directory(start);
        }

        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|err| ServiceError::Io {
        message: format!("the folder picker could not be opened: {err}"),
    })?;

    let Some(picked) = picked else {
        return Ok(None);
    };

    let path = picked.into_path().map_err(|err| ServiceError::Io {
        message: format!("that folder could not be used: {err}"),
    })?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_existing_writable_folder_is_fine() {
        let here = std::env::temp_dir();
        let check = check_directory(here.to_string_lossy().into_owned());

        assert_eq!(check.status, DirectoryStatus::Ok);
    }

    #[test]
    fn a_folder_that_is_not_there_yet_says_it_will_be_made() {
        let candidate = std::env::temp_dir().join("inferno-not-yet").join("deeper");
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("inferno-not-yet"));

        let check = check_directory(candidate.to_string_lossy().into_owned());

        assert_eq!(check.status, DirectoryStatus::WillCreate);
        // It names what it would be created inside, which is the reassuring
        // half of the message.
        assert!(check.existing_parent.is_some());
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let file = std::env::temp_dir().join("inferno-a-file.txt");
        std::fs::write(&file, b"x").expect("writes");

        let check = check_directory(file.to_string_lossy().into_owned());
        assert_eq!(check.status, DirectoryStatus::NotADirectory);

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_path_under_a_file_cannot_be_created() {
        let file = std::env::temp_dir().join("inferno-blocking-file.txt");
        std::fs::write(&file, b"x").expect("writes");

        let check =
            check_directory(file.join("inside").to_string_lossy().into_owned());
        assert_eq!(check.status, DirectoryStatus::NotADirectory);

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_missing_drive_is_its_own_answer() {
        let check = check_directory(r"Z:\nowhere\at\all".into());
        assert_eq!(check.status, DirectoryStatus::NoParent);
    }

    #[test]
    fn nothing_and_relative_paths_are_rejected_before_touching_the_disk() {
        assert_eq!(
            check_directory("   ".into()).status,
            DirectoryStatus::Invalid
        );
        assert_eq!(
            check_directory("downloads".into()).status,
            DirectoryStatus::Invalid
        );
    }
}
