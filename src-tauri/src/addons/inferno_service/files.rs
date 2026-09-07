//! Handing a finished download to the operating system.
//!
//! The one thing the HTTP API genuinely cannot do. Reading a file's *bytes*
//! still goes through `GET /api/v1/downloads/{id}/files/{name}` — this is only
//! "open it in whatever the user normally uses" and "show me where it is",
//! which are shell operations by definition. The paths come from the job
//! object (`job.directory`, `file.path`), exactly as SPEC §4.5 describes.

use std::path::{Path, PathBuf};
// Only the non-Windows handlers spawn a process; Windows uses ShellExecuteW.
#[cfg(not(windows))]
use std::process::Command;

use super::error::{ServiceError, ServiceResult};

/// Resolve and sanity-check a path handed over from the frontend.
///
/// Only existence is enforced. These commands do no more than the user could
/// do in their own file manager, so the check is here to turn a stale path -
/// a file moved or deleted since the job finished - into a clear error rather
/// than a shell command that silently does nothing.
fn checked(path: &str) -> ServiceResult<PathBuf> {
    let candidate = Path::new(path);
    if path.trim().is_empty() {
        return Err(ServiceError::Io {
            message: "No path was given.".into(),
        });
    }

    candidate.canonicalize().map_err(|_| ServiceError::Io {
        message: format!("{path} is no longer there. It may have been moved or deleted."),
    })
}

/// Strip the extended-length `\\?\` prefix that `canonicalize` adds on Windows.
///
/// Explorer does not understand that form and, rather than failing, silently
/// opens the user's Documents folder instead - which reads as a broken button.
/// A UNC path goes back to its familiar `\\server\share` form.
#[cfg(windows)]
fn shell_path(path: &Path) -> String {
    let display = path.to_string_lossy().into_owned();

    if let Some(unc) = display.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }

    display
        .strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or(display)
}

/// Only the non-Windows branches reach this now; Windows goes through
/// `ShellExecuteW` for files, folders and links alike.
#[cfg(not(windows))]
fn spawn(mut command: Command, what: &str) -> ServiceResult<()> {
    command.spawn().map(|_| ()).map_err(|err| ServiceError::Io {
        message: format!("Could not {what}: {err}"),
    })
}

/// The shell's own "open this", as Explorer performs it for a double-click.
///
/// Spawning `rundll32 url.dll,FileProtocolHandler` and hoping the path
/// survived is what made these buttons unreliable: that entry point is built
/// for URLs and re-parses whatever it is handed, so a real download name -
/// spaces, brackets, dashes - was not safe. `ShellExecuteW` takes wide strings
/// straight through and parses nothing.
#[cfg(windows)]
mod windows_shell {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    use super::{ServiceError, ServiceResult};

    pub fn open(file: &str, parameters: Option<&str>, what: &str) -> ServiceResult<()> {
        let file = HSTRING::from(file);
        // An empty string is how this API says "no parameters"; the binding
        // takes a plain PCWSTR rather than an Option.
        let parameters = HSTRING::from(parameters.unwrap_or_default());

        let result = unsafe {
            ShellExecuteW(
                None,
                &HSTRING::from("open"),
                &file,
                &parameters,
                None,
                SW_SHOWNORMAL,
            )
        };

        // Legacy API: the return is a pseudo-HINSTANCE and anything at or
        // below 32 is an error code, not a handle.
        let code = result.0 as isize;
        if code <= 32 {
            return Err(ServiceError::Io {
                message: format!("Could not {what} (shell error {code})."),
            });
        }

        Ok(())
    }
}

/// Accept only `http(s)` links.
///
/// Anything reaching the shell is worth being narrow about: other schemes
/// (`file:`, `javascript:`, `ms-msdt:`) have been the basis of real handler
/// exploits, and the app only ever needs to open a web page a service response
/// gave it. A rejected URL is a bug worth seeing, not something to paper over.
///
/// `&`, `|`, `^`, `<` and `>` were refused here too, back when this spawned
/// `rundll32 url.dll,FileProtocolHandler` and the URL had to survive a command
/// line being re-parsed. That rejected perfectly ordinary links - a YouTube URL
/// carrying a playlist and an index is full of `&`, so opening one failed on a
/// large share of real videos. The handler is `ShellExecuteW` now, which takes a
/// wide string straight through and parses nothing, so the only characters still
/// worth refusing are the ones that cannot appear in a URL at all: quotes,
/// whitespace and control characters.
fn checked_url(url: &str) -> ServiceResult<String> {
    let trimmed = url.trim();

    let ok = (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && trimmed.len() > 8
        && !trimmed.contains(['"', '\''])
        && !trimmed.contains(char::is_whitespace)
        && !trimmed.chars().any(char::is_control);

    if !ok {
        return Err(ServiceError::Io {
            message: format!("{url} is not a link this app will open."),
        });
    }

    Ok(trimmed.to_owned())
}

/// Open a web link in whatever the user browses with.
#[tauri::command]
pub fn inferno_open_url(url: String) -> ServiceResult<()> {
    let target = checked_url(&url)?;

    #[cfg(windows)]
    {
        // The same route the file commands take, and for the same reason:
        // rundll32 re-parses whatever it is handed, so a URL with a query
        // string was never safe to pass that way.
        windows_shell::open(&target, None, "open that link")
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(&target);
        spawn(command, "open that link")
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        spawn(command, "open that link")
    }
}

/// The deepest part of `path` that still exists on disk.
///
/// Walks up from the file towards the drive and stops at the first hit, so it
/// costs at most one `exists` per path segment - a handful of calls for any
/// real path, and the caller makes it once when a dialog opens rather than per
/// render. Returns `None` when even the root is gone (a removed drive, an
/// unmounted share).
#[tauri::command]
pub fn inferno_existing_ancestor(path: String) -> Option<String> {
    let mut candidate = Some(Path::new(&path));

    while let Some(current) = candidate {
        if current.as_os_str().is_empty() {
            break;
        }
        if current.exists() {
            return Some(current.to_string_lossy().into_owned());
        }
        candidate = current.parent();
    }

    None
}


/// How a path is written when it is handed back to the app.
fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        shell_path(path)
    }

    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

/// A name that is free in `folder`, numbering rather than overwriting.
///
/// The same policy the service uses when it publishes a job, so a file that
/// lands here keeps the shape someone would expect from the one that landed
/// there: `clip.mp4`, then `clip (2).mp4`.
fn free_name(folder: &Path, file_name: &str) -> PathBuf {
    let candidate = folder.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let named = Path::new(file_name);
    let stem = named
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_owned());
    let extension = named
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();

    for suffix in 2..1000 {
        let candidate = folder.join(format!("{stem} ({suffix}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    // A thousand of the same name is not a real situation; overwriting is
    // still wrong, so the caller gets the clash and can say so.
    folder.join(file_name)
}

/// Move a finished download into the folder it was meant to end up in.
///
/// The service publishes into its own download folder and has no field for
/// anywhere else, so a destination the *app* knows about - the save location,
/// or a folder chosen when the download finished - is applied here, once the
/// file exists and there is something to move.
///
/// Numbering rather than asking or overwriting: the download has already
/// succeeded by this point, and a dialog about a name clash is a poor reward
/// for that. `async` because it can be a copy across volumes.
#[tauri::command]
pub async fn inferno_place_download(source: String, folder: String) -> ServiceResult<String> {
    tauri::async_runtime::spawn_blocking(move || place_download(&source, &folder))
        .await
        .map_err(|err| ServiceError::Io {
            message: format!("the download could not be moved: {err}"),
        })?
}

fn place_download(source: &str, folder: &str) -> ServiceResult<String> {
    let file = checked(source)?;
    let wanted = folder.trim();

    if wanted.is_empty() {
        return Err(ServiceError::Io {
            message: "No folder was given.".into(),
        });
    }

    let destination = Path::new(wanted);
    std::fs::create_dir_all(destination).map_err(|err| ServiceError::Io {
        message: format!("Could not create {}: {err}", destination.display()),
    })?;

    // Canonical on both sides before comparing: one is `\?\C:\...` from
    // `checked` and the other is whatever was typed, and they are the same
    // folder often enough that this matters.
    let destination = destination.canonicalize().map_err(|err| ServiceError::Io {
        message: format!("Could not open {wanted}: {err}"),
    })?;

    // Already there. Moving a file onto itself is how you end up with no file.
    if file.parent() == Some(destination.as_path()) {
        return Ok(display_path(&file));
    }

    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| ServiceError::Io {
            message: format!("{source} does not name a file."),
        })?;

    let target = free_name(&destination, &name);

    // A rename is instant within a volume and simply fails across one, so it
    // is worth trying before paying for a copy of a video file.
    if std::fs::rename(&file, &target).is_err() {
        std::fs::copy(&file, &target).map_err(|err| ServiceError::Io {
            message: format!("Could not move the download: {err}"),
        })?;

        // The copy is the file now; failing to tidy the original is untidy
        // rather than wrong, so it does not fail the move.
        let _ = std::fs::remove_file(&file);
    }

    Ok(display_path(&target))
}

/// Open a file or folder with whatever the OS considers its default handler.
#[tauri::command]
pub fn inferno_open_path(path: String) -> ServiceResult<()> {
    let target = checked(&path)?;

    #[cfg(windows)]
    {
        // Prefix-stripped first: `canonicalize` returns an extended-length
        // `\\?\` path, which the shell does not accept.
        windows_shell::open(&shell_path(&target), None, "open that file")
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(&target);
        spawn(command, "open that file")
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(&target);
        spawn(command, "open that file")
    }
}

/// Show a file in its containing folder, selected where the platform allows.
#[tauri::command]
pub fn inferno_reveal_path(path: String) -> ServiceResult<()> {
    let target = checked(&path)?;

    #[cfg(windows)]
    {
        let plain = shell_path(&target);

        if target.is_dir() {
            windows_shell::open(&plain, None, "show that folder")
        } else {
            // Explorer's own argument parsing is unreliable, so the path is
            // quoted inside a single parameter string rather than passed as
            // an argv entry.
            windows_shell::open(
                "explorer.exe",
                Some(&format!("/select,\"{plain}\"")),
                "show that file",
            )
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if target.is_dir() {
            command.arg(&target);
        } else {
            command.arg("-R").arg(&target);
        }
        spawn(command, "show that file")
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select the file" on Linux; open the folder.
        let folder = if target.is_dir() {
            target.clone()
        } else {
            target.parent().unwrap_or(&target).to_path_buf()
        };
        let mut command = Command::new("xdg-open");
        command.arg(folder);
        spawn(command, "show that folder")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own per test, so they can run in any order at once.
    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("inferno-place-{name}"));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).expect("scratch folder");

        folder
    }

    fn file_holding(path: &Path, contents: &str) {
        std::fs::write(path, contents).expect("write");
    }

    #[test]
    fn a_download_is_moved_into_the_folder_and_leaves_nothing_behind() {
        let root = scratch("moved");
        let source = root.join("clip.mp4");
        let destination = root.join("saved");
        file_holding(&source, "video");

        let landed = place_download(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
        )
        .expect("moved");

        assert!(landed.ends_with("clip.mp4"));
        assert!(destination.join("clip.mp4").exists());
        assert!(!source.exists(), "the original should not still be there");
    }

    #[test]
    fn a_folder_that_is_not_there_yet_is_created() {
        let root = scratch("created");
        let source = root.join("clip.mp4");
        file_holding(&source, "video");

        let destination = root.join("one").join("two");
        place_download(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
        )
        .expect("moved");

        assert!(destination.join("clip.mp4").exists());
    }

    #[test]
    fn a_name_already_in_the_folder_is_numbered_rather_than_overwritten() {
        let root = scratch("numbered");
        let destination = root.join("saved");
        std::fs::create_dir_all(&destination).expect("destination");
        file_holding(&destination.join("clip.mp4"), "the first one");

        let source = root.join("clip.mp4");
        file_holding(&source, "the second one");

        place_download(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
        )
        .expect("moved");

        assert_eq!(
            std::fs::read_to_string(destination.join("clip.mp4")).unwrap(),
            "the first one",
            "the file already there must be left alone"
        );
        assert_eq!(
            std::fs::read_to_string(destination.join("clip (2).mp4")).unwrap(),
            "the second one"
        );
    }

    #[test]
    fn a_file_already_in_the_destination_is_left_where_it_is() {
        let root = scratch("already");
        let source = root.join("clip.mp4");
        file_holding(&source, "video");

        let landed =
            place_download(&source.to_string_lossy(), &root.to_string_lossy()).expect("kept");

        assert!(landed.ends_with("clip.mp4"));
        assert!(
            source.exists(),
            "moving a file onto itself must not delete it"
        );
    }

    #[test]
    fn a_folder_is_required() {
        let root = scratch("nofolder");
        let source = root.join("clip.mp4");
        file_holding(&source, "video");

        assert!(place_download(&source.to_string_lossy(), "   ").is_err());
    }

    #[test]
    fn a_missing_path_is_an_error_rather_than_a_silent_no_op() {
        let error = checked("Z:\\definitely\\not\\here.mp4").unwrap_err();
        assert!(matches!(error, ServiceError::Io { .. }));
    }

    #[test]
    fn an_empty_path_is_rejected() {
        assert!(checked("   ").is_err());
    }

    /// Actually opens a file, so it launches a real handler window. Ignored by
    /// default; run deliberately with `--ignored` when changing the shell call.
    #[cfg(windows)]
    #[ignore]
    #[test]
    fn open_launches_a_handler_for_a_realistic_name() {
        // The name is the point: spaces, brackets and dashes are what the old
        // rundll32 route could not be trusted with.
        let path = std::env::temp_dir()
            .join("Big Buck Bunny 60fps 4K - Official Blender [aqz-KE-bpKQ].txt");
        std::fs::write(&path, b"inferno shell test").expect("writes");

        inferno_open_path(path.to_string_lossy().into_owned())
            .expect("ShellExecuteW reported success");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_existing_ancestor_is_the_deepest_real_directory() {
        let here = std::env::current_dir().expect("a working directory");
        let missing = here.join("no-such-folder").join("no-such-file.mp4");

        let found = inferno_existing_ancestor(missing.to_string_lossy().into_owned())
            .expect("something above it exists");

        // The walk stops at the first hit rather than climbing to the root.
        assert_eq!(Path::new(&found), here.as_path());
    }

    #[test]
    fn an_existing_file_is_its_own_ancestor() {
        let here = std::env::current_dir().expect("a working directory");
        let found = inferno_existing_ancestor(here.to_string_lossy().into_owned());
        assert_eq!(found.as_deref().map(Path::new), Some(here.as_path()));
    }

    #[test]
    fn a_path_with_no_surviving_root_reports_nothing() {
        assert!(inferno_existing_ancestor(r"Z:\gone\also-gone.mp4".into()).is_none());
    }

    #[test]
    fn only_plain_web_links_are_opened() {
        assert!(checked_url("https://www.youtube.com/watch?v=abc123").is_ok());
        assert!(checked_url("http://example.com/a/b").is_ok());
        // Other schemes never reach a handler.
        assert!(checked_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(checked_url("javascript:alert(1)").is_err());
        assert!(checked_url("ms-msdt:/id PCWDiagnostic").is_err());
        // Query strings are ordinary: a link carrying a playlist and an
        // index is the common case, not the exception.
        assert!(checked_url("https://www.youtube.com/watch?v=abc&t=42s").is_ok());
        assert!(checked_url(
            "https://www.youtube.com/watch?v=xJIYF6KwK3w&list=RD4D_5G9Sac8w&index=28"
        )
        .is_ok());
        assert!(checked_url("https://x.test/a b").is_err());
        assert!(checked_url("https://x.test/\"q\"").is_err());
        assert!(checked_url("https://").is_err());
        assert!(checked_url("").is_err());
    }

    #[test]
    fn an_existing_path_resolves() {
        let here = std::env::current_dir().expect("a working directory");
        assert!(checked(&here.to_string_lossy()).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn the_extended_length_prefix_is_stripped_for_explorer() {
        assert_eq!(
            shell_path(Path::new(r"\\?\C:\Users\a\Downloads\clip.mp4")),
            r"C:\Users\a\Downloads\clip.mp4"
        );
        assert_eq!(
            shell_path(Path::new(r"\\?\UNC\server\share\clip.mp4")),
            r"\\server\share\clip.mp4"
        );
        // An ordinary path is left exactly as it is.
        assert_eq!(
            shell_path(Path::new(r"D:\Media\clip.mp4")),
            r"D:\Media\clip.mp4"
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonicalize_really_does_produce_the_prefix_we_strip() {
        // Guards the assumption the stripping exists for. If std ever stops
        // returning extended-length paths, this fails loudly instead of the
        // reveal button quietly regressing.
        let here = std::env::current_dir().expect("a working directory");
        let canonical = here.canonicalize().expect("canonicalises");
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        assert!(!shell_path(&canonical).starts_with(r"\\?\"));
    }
}
