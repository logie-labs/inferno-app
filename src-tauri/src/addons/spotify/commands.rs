//! The Spotify integration's command surface.

use std::path::{Path, PathBuf};

use serde::Serialize;

use tauri_plugin_dialog::DialogExt;

use crate::addons::inferno_service::{ServiceError, ServiceResult};

use super::probe::{self, SpotifyInstallation};
use super::tracks::{read_tracks, Track};

/// What the setup screen needs to know before it can ask anything.
#[derive(Debug, Clone, Serialize)]
pub struct SpotifySurvey {
    pub installations: Vec<SpotifyInstallation>,
    /// True when Spotify is installed but no account lists a single folder.
    ///
    /// Its own answer rather than something the UI infers from empty arrays,
    /// because it is the case that needs explaining: local files are off, or
    /// no source folder has been added, and Spotify has to be restarted after
    /// either is changed before it writes the banks this reads.
    pub needs_local_files_enabled: bool,
}

/// Look for Spotify, its accounts, and the folders they watch.
///
/// Reads a handful of small files and stats some directories, so it is cheap
/// enough to run whenever the setup screen opens rather than being cached -
/// and it *must* be re-run on demand, because the whole point of the "turn it
/// on and restart Spotify" instruction is that the answer changes.
///
/// Off the main thread: it stats directories and reads files, and it runs as
/// the Spotify settings section mounts - blocking there is a section that
/// appears without its transition.
#[tauri::command]
pub async fn spotify_survey() -> SpotifySurvey {
    tauri::async_runtime::spawn_blocking(run_survey)
        .await
        .unwrap_or(SpotifySurvey {
            needs_local_files_enabled: false,
            installations: Vec::new(),
        })
}

fn run_survey() -> SpotifySurvey {
    let installations = probe::installations();

    let any_folder = installations
        .iter()
        .flat_map(|install| &install.accounts)
        .any(|account| !account.folders.is_empty());

    SpotifySurvey {
        needs_local_files_enabled: !installations.is_empty() && !any_folder,
        installations,
    }
}

/// Ask for a folder to add by hand.
///
/// The probe only knows what Spotify has already written down, and it writes
/// on shutdown - so a folder added in Spotify a minute ago is invisible until
/// it restarts. Rather than making someone wait for that, they can point at the
/// folder themselves; the table then says plainly that nobody has confirmed
/// Spotify is watching it.
///
/// `async` plus `spawn_blocking` for the same reason as the library's locate
/// command: the picker waits on a modal the main thread has to pump.
#[tauri::command]
pub async fn spotify_pick_folder(app: tauri::AppHandle) -> ServiceResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a Spotify local-files folder")
            .blocking_pick_folder()
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

/// Enough of a folder to browse. A library can be enormous, and this is a
/// dialog, not a music player.
const MAX_TRACKS: usize = 500;

/// What Spotify will index, so the listing matches what it would actually see.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "m4p", "mp4", "flac", "ogg", "wav", "aac", "wma",
];

/// List the audio files in one folder, with their tags.
///
/// Reads the head of every file, so it is deliberately capped and deliberately
/// not called on the settings screen until someone asks to look.
#[tauri::command]
pub async fn spotify_folder_tracks(folder: String) -> ServiceResult<Vec<Track>> {
    tauri::async_runtime::spawn_blocking(move || list_folder_tracks(folder))
        .await
        .map_err(|err| ServiceError::Io {
            message: format!("that folder could not be read: {err}"),
        })?
}

fn list_folder_tracks(folder: String) -> ServiceResult<Vec<Track>> {
    let folder = PathBuf::from(&folder);

    let entries = std::fs::read_dir(&folder).map_err(|err| ServiceError::Io {
        message: format!("Could not read {}: {err}", folder.display()),
    })?;

    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .map(|ext| {
                        AUDIO_EXTENSIONS
                            .contains(&ext.to_string_lossy().to_ascii_lowercase().as_str())
                    })
                    .unwrap_or(false)
        })
        .collect();

    // Newest first: what was just delivered is what someone is looking for.
    paths.sort_by_key(|path| {
        std::cmp::Reverse(
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_secs())
                .unwrap_or(0),
        )
    });
    paths.truncate(MAX_TRACKS);

    Ok(read_tracks(&paths))
}

/// A name that is free in `folder`, numbering rather than overwriting.
///
/// The same rule the download folder uses: `track.mp3`, then `track (1).mp3`.
/// Overwriting would be worse than a duplicate - the file already there may be
/// a different recording someone deliberately keeps.
fn unique_path(folder: &Path, file_name: &str) -> PathBuf {
    let candidate = folder.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_owned());
    let extension = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    for n in 1..10_000 {
        let candidate = folder.join(format!("{stem} ({n}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    folder.join(file_name)
}

/// What happened, or what needs deciding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Nothing was in the way.
    Placed,
    /// Something was, and it was overwritten.
    Replaced,
    /// Something was, and both are now there under different names.
    KeptBoth,
    /// Something was, and this one was left behind.
    Skipped,
    /// Something is, and nobody has said what to do about it yet. Nothing has
    /// been written; the caller asks and calls back with a decision.
    Conflict,
}

/// Enough about the file already there to tell it apart from the new one.
#[derive(Debug, Clone, Serialize)]
pub struct ExistingFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Seconds since the epoch.
    pub modified: Option<u64>,
}

fn describe(path: &Path) -> ExistingFile {
    let meta = std::fs::metadata(path).ok();

    ExistingFile {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified: meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Placement {
    pub outcome: Outcome,
    /// Where it ended up. Absent when nothing was written.
    pub path: Option<String>,
    /// Whether the original was left where it was.
    pub kept_original: bool,
    /// The file in the way, when there is one.
    pub existing: Option<ExistingFile>,
}

/// Move or copy `source` to `destination`, replacing whatever is there.
fn transfer(source: &Path, destination: &Path, keep_original: bool) -> ServiceResult<()> {
    let folder = destination.parent().unwrap_or(destination);

    if keep_original {
        std::fs::copy(source, destination).map_err(|err| ServiceError::Io {
            message: format!("Could not copy into {}: {err}", folder.display()),
        })?;

        return Ok(());
    }

    // `rename` will not overwrite on Windows, so the way has to be cleared
    // first. Only reached once someone has chosen to replace.
    if destination.exists() {
        let _ = std::fs::remove_file(destination);
    }

    if std::fs::rename(source, destination).is_err() {
        // Almost always a different volume, which `rename` cannot do.
        std::fs::copy(source, destination).map_err(|err| ServiceError::Io {
            message: format!("Could not move into {}: {err}", folder.display()),
        })?;
        // The copy is the file now; failing to remove the original leaves a
        // duplicate rather than losing anything, so it is not fatal.
        let _ = std::fs::remove_file(source);
    }

    Ok(())
}

/// Put a finished download into a Spotify local-files folder.
///
/// `keep_original` is the difference between "copy to both" and "Spotify
/// only".
///
/// `on_conflict` decides what happens when the name is taken: `ask` writes
/// nothing and hands the decision back, which is what the app does by default.
/// The alternatives - `replace`, `keep_both`, `skip` - are what it calls with
/// once someone has chosen, and are also how "do this for the rest" is applied
/// without asking again.
#[tauri::command]
pub async fn spotify_place(
    source: String,
    folder: String,
    keep_original: bool,
    on_conflict: String,
) -> ServiceResult<Placement> {
    // Copying a whole file, so emphatically not on the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        place_file(source, folder, keep_original, on_conflict)
    })
    .await
    .map_err(|err| ServiceError::Io {
        message: format!("that file could not be placed: {err}"),
    })?
}

fn place_file(
    source: String,
    folder: String,
    keep_original: bool,
    on_conflict: String,
) -> ServiceResult<Placement> {
    let source = PathBuf::from(&source);
    let folder = PathBuf::from(&folder);

    if !source.is_file() {
        return Err(ServiceError::Io {
            message: format!("{} is no longer there.", source.display()),
        });
    }
    if !folder.is_dir() {
        return Err(ServiceError::Io {
            message: format!(
                "{} is not there any more. Pick the folder again in Settings.",
                folder.display()
            ),
        });
    }

    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| ServiceError::Io {
            message: "That download has no file name.".into(),
        })?;

    let destination = folder.join(&file_name);

    // The ordinary case: nothing is in the way and nobody needs asking.
    if !destination.exists() {
        transfer(&source, &destination, keep_original)?;

        return Ok(Placement {
            outcome: Outcome::Placed,
            path: Some(destination.to_string_lossy().into_owned()),
            kept_original: keep_original,
            existing: None,
        });
    }

    match on_conflict.as_str() {
        "replace" => {
            transfer(&source, &destination, keep_original)?;

            Ok(Placement {
                outcome: Outcome::Replaced,
                path: Some(destination.to_string_lossy().into_owned()),
                kept_original: keep_original,
                existing: None,
            })
        }
        "keep_both" => {
            let target = unique_path(&folder, &file_name);
            transfer(&source, &target, keep_original)?;

            Ok(Placement {
                outcome: Outcome::KeptBoth,
                path: Some(target.to_string_lossy().into_owned()),
                kept_original: keep_original,
                existing: None,
            })
        }
        "skip" => Ok(Placement {
            outcome: Outcome::Skipped,
            path: None,
            // Nothing was written, so the original is untouched whatever was
            // asked for.
            kept_original: true,
            existing: Some(describe(&destination)),
        }),
        // "ask", and anything unrecognised, is the safe reading: do nothing.
        _ => Ok(Placement {
            outcome: Outcome::Conflict,
            path: None,
            kept_original: true,
            existing: Some(describe(&destination)),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clashing_name_is_numbered_rather_than_overwritten() {
        let dir = std::env::temp_dir().join("inferno-spotify-unique");
        let _ = std::fs::create_dir_all(&dir);

        let first = dir.join("song.mp3");
        std::fs::write(&first, b"one").expect("writes");

        let next = unique_path(&dir, "song.mp3");
        assert_eq!(next.file_name().unwrap(), "song (1).mp3");

        std::fs::write(&next, b"two").expect("writes");
        assert_eq!(
            unique_path(&dir, "song.mp3").file_name().unwrap(),
            "song (2).mp3"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_free_name_is_used_as_it_is() {
        let dir = std::env::temp_dir().join("inferno-spotify-free");
        let _ = std::fs::create_dir_all(&dir);

        assert_eq!(
            unique_path(&dir, "nothing-here.mp3").file_name().unwrap(),
            "nothing-here.mp3"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_with_no_extension_still_numbers() {
        let dir = std::env::temp_dir().join("inferno-spotify-noext");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("track"), b"x").expect("writes");

        assert_eq!(unique_path(&dir, "track").file_name().unwrap(), "track (1)");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn placing_a_missing_source_is_an_error_not_a_silent_no_op() {
        let dir = std::env::temp_dir();
        let result = place_file(
            dir.join("definitely-not-here.mp3").to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            true,
            "ask".into(),
        );

        assert!(result.is_err());
    }

    /// A scratch source file and an empty destination folder.
    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("inferno-spotify-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        let from = root.join("from");
        let to = root.join("to");
        std::fs::create_dir_all(&from).expect("creates");
        std::fs::create_dir_all(&to).expect("creates");

        let source = from.join("song.mp3");
        std::fs::write(&source, b"new").expect("writes");

        (source, to)
    }

    #[test]
    fn a_free_name_is_placed_without_asking() {
        let (source, folder) = fixture("free");

        let placed = place_file(
            source.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            true,
            "ask".into(),
        )
        .expect("places");

        assert_eq!(placed.outcome, Outcome::Placed);
        assert!(folder.join("song.mp3").is_file());
    }

    #[test]
    fn a_taken_name_reports_a_conflict_and_writes_nothing() {
        let (source, folder) = fixture("conflict");
        std::fs::write(folder.join("song.mp3"), b"old").expect("writes");

        let placed = place_file(
            source.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            false,
            "ask".into(),
        )
        .expect("reports");

        assert_eq!(placed.outcome, Outcome::Conflict);
        assert!(placed.path.is_none());
        assert_eq!(placed.existing.expect("describes it").size, 3);
        // Nothing moved: asking must not be destructive, even when the mode
        // would otherwise have taken the original away.
        assert!(source.is_file());
        assert_eq!(
            std::fs::read(folder.join("song.mp3")).expect("reads"),
            b"old"
        );
    }

    #[test]
    fn replace_overwrites_even_when_moving() {
        let (source, folder) = fixture("replace");
        std::fs::write(folder.join("song.mp3"), b"old").expect("writes");

        let placed = place_file(
            source.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            false,
            "replace".into(),
        )
        .expect("replaces");

        assert_eq!(placed.outcome, Outcome::Replaced);
        assert_eq!(
            std::fs::read(folder.join("song.mp3")).expect("reads"),
            b"new"
        );
        // Moved, so the original is gone.
        assert!(!source.is_file());
    }

    #[test]
    fn keep_both_numbers_the_newcomer_and_leaves_the_old_one() {
        let (source, folder) = fixture("both");
        std::fs::write(folder.join("song.mp3"), b"old").expect("writes");

        let placed = place_file(
            source.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            true,
            "keep_both".into(),
        )
        .expect("keeps both");

        assert_eq!(placed.outcome, Outcome::KeptBoth);
        assert_eq!(
            std::fs::read(folder.join("song.mp3")).expect("reads"),
            b"old"
        );
        assert_eq!(
            std::fs::read(folder.join("song (1).mp3")).expect("reads"),
            b"new"
        );
    }

    #[test]
    fn skip_leaves_both_sides_exactly_as_they_were() {
        let (source, folder) = fixture("skip");
        std::fs::write(folder.join("song.mp3"), b"old").expect("writes");

        let placed = place_file(
            source.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            false,
            "skip".into(),
        )
        .expect("skips");

        assert_eq!(placed.outcome, Outcome::Skipped);
        // Skipping a move must not delete the original.
        assert!(placed.kept_original);
        assert!(source.is_file());
        assert_eq!(
            std::fs::read(folder.join("song.mp3")).expect("reads"),
            b"old"
        );
    }
}
