//! Handing a finished download to the operating system.
//!
//! The one thing the HTTP API genuinely cannot do. Reading a file's *bytes*
//! still goes through `GET /api/v1/downloads/{id}/files/{name}` — this is only
//! "open it in whatever the user normally uses" and "show me where it is",
//! which are shell operations by definition. The paths come from the job
//! object (`job.directory`, `file.path`), exactly as SPEC §4.5 describes.

use std::path::{Path, PathBuf};
// The download shells out to curl everywhere. Opening and revealing files
// spawns a process too, but only off Windows - there ShellExecuteW does it.
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

/// Is the file the service resolved still on disk?
///
/// Worth asking because `/health` cannot: the service resolves its binaries
/// once at startup and caches the result for the rest of its life, so a file
/// deleted afterwards still reports as present and everything downstream
/// believes an install that no longer exists.
#[tauri::command]
pub fn inferno_verify_binary(path: String) -> bool {
    Path::new(&path).is_file()
}

/// The name a vendored binary goes by on this platform.
fn vendor_file_name(relative: &str) -> String {
    if cfg!(windows) && !relative.ends_with(".exe") {
        format!("{relative}.exe")
    } else {
        relative.to_string()
    }
}

/// Where a vendored binary belongs, whether or not one is there now.
///
/// The first vendor root, which is the one the service is pointed at when it
/// spawns - so a file put here is the file it will resolve next time it looks.
/// Needed because the interesting case is the one where nothing resolved at
/// all: `/health` then reports no path, and "put it back where it was" has to
/// become "put it where it goes".
#[tauri::command]
pub fn inferno_vendor_path(app: tauri::AppHandle, bundled: String) -> ServiceResult<String> {
    let root = super::process::vendor_dir(&app).ok_or_else(|| ServiceError::Io {
        message: "This build has no vendor directory to put a replacement in.".into(),
    })?;

    Ok(display_path(&root.join(vendor_file_name(&bundled))))
}

/// Fetch a replacement over HTTPS, reporting how far along it is.
///
/// Shelled out to `curl` rather than done with an HTTP crate. That is a real
/// trade and worth naming: `reqwest` is already in the tree but carries no TLS
/// backend, and every way of giving it one pulls in a stack this project would
/// otherwise not build - so the choice was between a large new dependency and
/// the HTTPS client that Windows, macOS and most Linux installs already ship.
/// curl verifies certificates properly, which is the part that matters.
///
/// The frontend cannot do this itself: GitHub serves release assets with no
/// `Access-Control-Allow-Origin`, so a `fetch` from the webview is refused.
///
/// Written to a `.part` beside the target and moved into place only once the
/// digest agrees, so an interrupted download can never be mistaken for a
/// working binary.
/// One file to lift out of a downloaded archive.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExtractTarget {
    /// The entry's own file name, ignoring whatever folders it sits in -
    /// these archives put everything under a versioned directory.
    pub name: String,
    /// Where it should end up.
    pub destination: String,
}

#[tauri::command]
pub async fn inferno_download_binary(
    path: String,
    url: String,
    sha256: Option<String>,
    checksum_url: Option<String>,
    extract: Option<Vec<ExtractTarget>>,
) -> ServiceResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_binary(
            &path,
            &url,
            sha256.as_deref(),
            checksum_url.as_deref(),
            extract.as_deref(),
        )
    })
    .await
    .map_err(|err| ServiceError::Io {
        message: format!("the download did not finish: {err}"),
    })?
}

/// Fetch a published digest and pull the hash out of it.
///
/// Fetched here rather than in the frontend because the file lives on the
/// build host's own site, which sends no CORS headers - the webview would be
/// refused. Doing it in the same command as the download also means the two
/// cannot drift: one call, one answer, verified before anything is moved into
/// place.
///
/// The format is not standardised. Some publish a bare hash, some the
/// `sha256sum` form of `<hash>  <filename>`, so the first 64 hex characters
/// are taken and the rest ignored.
fn fetch_checksum(url: &str) -> ServiceResult<String> {
    let checked = checked_url(url)?;
    if !checked.starts_with("https://") {
        return Err(ServiceError::Io {
            message: "A checksum may only be fetched over HTTPS.".into(),
        });
    }

    let mut command = Command::new("curl");
    command.args([
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--max-time",
        "30",
    ]);
    command.arg(&checked);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let output = command.output().map_err(|err| ServiceError::Io {
        message: format!("could not fetch the checksum: {err}"),
    })?;

    if !output.status.success() {
        return Err(ServiceError::Io {
            message: "The published checksum could not be fetched.".into(),
        });
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let digest: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_hexdigit())
        .take_while(char::is_ascii_hexdigit)
        .collect();

    if digest.len() != 64 {
        return Err(ServiceError::Io {
            message: "The published checksum was not a SHA-256.".into(),
        });
    }

    Ok(digest)
}

/// Pull the wanted files out of a downloaded archive.
///
/// Matched on file name alone, because these archives wrap everything in a
/// folder named after the version - `ffmpeg-9.0.1-essentials_build/bin/` - so
/// a full path would have to be guessed afresh with every release.
///
/// Nothing is written straight to its destination: each file lands beside it
/// and is renamed into place, so a half-extracted executable is never left
/// somewhere the service might pick it up.
fn extract_from_archive(archive: &Path, targets: &[ExtractTarget]) -> ServiceResult<()> {
    let file = std::fs::File::open(archive).map_err(|err| ServiceError::Io {
        message: format!("could not open the download: {err}"),
    })?;

    let mut zip = zip::ZipArchive::new(file).map_err(|err| ServiceError::Io {
        message: format!("the download is not a readable archive: {err}"),
    })?;

    for target in targets {
        let mut found = false;

        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(|err| ServiceError::Io {
                message: format!("could not read the archive: {err}"),
            })?;

            // `enclosed_name` refuses paths that climb out of the archive, so
            // a crafted zip cannot write over something elsewhere on disk.
            let Some(entry_path) = entry.enclosed_name() else {
                continue;
            };

            if entry_path.file_name().and_then(|name| name.to_str()) != Some(target.name.as_str()) {
                continue;
            }

            let destination = PathBuf::from(&target.destination);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|err| ServiceError::Io {
                    message: format!("could not create {}: {err}", parent.display()),
                })?;
            }

            let staged = destination.with_extension("unpacking");
            let mut out = std::fs::File::create(&staged).map_err(|err| ServiceError::Io {
                message: format!("could not write {}: {err}", staged.display()),
            })?;

            std::io::copy(&mut entry, &mut out).map_err(|err| ServiceError::Io {
                message: format!("could not unpack {}: {err}", target.name),
            })?;
            drop(out);

            std::fs::rename(&staged, &destination).map_err(|err| ServiceError::Io {
                message: format!("could not put {} in place: {err}", destination.display()),
            })?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755));
            }

            found = true;
            break;
        }

        if !found {
            return Err(ServiceError::Io {
                message: format!("the download contained no {}.", target.name),
            });
        }
    }

    Ok(())
}

fn download_binary(
    path: &str,
    url: &str,
    sha256: Option<&str>,
    checksum_url: Option<&str>,
    extract: Option<&[ExtractTarget]>,
) -> ServiceResult<String> {
    // The same validation the "open this link" command uses, plus a refusal of
    // plain HTTP - this one ends in an executable on disk.
    let checked = checked_url(url)?;
    if !checked.starts_with("https://") {
        return Err(ServiceError::Io {
            message: "A replacement may only be fetched over HTTPS.".into(),
        });
    }

    let target = PathBuf::from(path);
    let parent = target.parent().ok_or_else(|| ServiceError::Io {
        message: format!("{path} has nowhere to be written to."),
    })?;

    std::fs::create_dir_all(parent).map_err(|err| ServiceError::Io {
        message: format!("could not create {}: {err}", parent.display()),
    })?;

    let partial = parent.join(format!(
        "{}.part",
        target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".into())
    ));
    let _ = std::fs::remove_file(&partial);

    let mut command = Command::new("curl");
    command.args([
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        // Redirects are followed, so every hop has to stay on HTTPS too.
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--output",
    ]);
    command.arg(&partial);
    command.arg(&checked);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up behind the app.
        command.creation_flags(0x0800_0000);
    }

    let outcome = command.status().map_err(|err| ServiceError::Io {
        message: format!("could not start curl: {err}"),
    })?;

    if !outcome.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(ServiceError::Io {
            message: format!("the download failed ({outcome})."),
        });
    }

    // A digest handed in directly wins; otherwise one is fetched from wherever
    // the build was published. Resolved before the file is hashed so a failure
    // to get it stops the repair rather than silently skipping verification.
    let expected = match sha256 {
        Some(value) => Some(value.to_owned()),
        None => match checksum_url {
            Some(url) => Some(fetch_checksum(url).inspect_err(|_| {
                let _ = std::fs::remove_file(&partial);
            })?),
            None => None,
        },
    };

    if let Some(expected) = expected {
        let actual = sha256_file(&partial)?;
        if !actual.eq_ignore_ascii_case(&expected) {
            let _ = std::fs::remove_file(&partial);
            return Err(ServiceError::Io {
                message: "The download did not match its published checksum.".into(),
            });
        }
    }

    // An archive is not the answer, it contains the answer. The wanted files
    // are lifted out and the download itself is thrown away, so nothing is
    // left behind for the resolver to trip over.
    if let Some(targets) = extract.filter(|targets| !targets.is_empty()) {
        let unpacked = extract_from_archive(&partial, targets);
        let _ = std::fs::remove_file(&partial);
        unpacked?;

        return Ok(targets[0].destination.clone());
    }

    std::fs::rename(&partial, &target).map_err(|err| ServiceError::Io {
        message: format!("could not put {} in place: {err}", target.display()),
    })?;

    // Downloaded binaries arrive without the bit that lets them run.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }

    Ok(display_path(&target))
}

/// SHA-256 of a file, whole.
///
/// Deliberately not `library::signature`, which hashes only both ends of a
/// file: that answers "is this the same download?" cheaply for multi-gigabyte
/// video, and explicitly does not prove a file is what it claims to be. This
/// one is for the bundled binaries, where the whole point is a digest somebody
/// can hold against a published checksum - so every byte goes in, and the
/// couple of hundred milliseconds that costs on an 80 MB executable is the
/// price of the answer being worth anything.
///
/// Streamed in chunks rather than read whole: `ffmpeg.exe` is large enough
/// that loading it into memory to hash it would be a visible cost for nothing.
#[tauri::command]
pub async fn inferno_hash_file(path: String) -> ServiceResult<String> {
    tauri::async_runtime::spawn_blocking(move || sha256_file(&checked(&path)?))
        .await
        .map_err(|err| ServiceError::Io {
            message: format!("hashing did not finish: {err}"),
        })?
}

/// The digest itself, split out so it can be tested without an app handle.
fn sha256_file(target: &Path) -> ServiceResult<String> {
    use std::io::Read;

    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(target).map_err(|err| ServiceError::Io {
        message: format!("could not read {}: {err}", target.display()),
    })?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|err| ServiceError::Io {
            message: format!("could not read {}: {err}", target.display()),
        })?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
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

    /// The digest is the whole point of the feature, so it is pinned to
    /// known-good values rather than to whatever the code happens to produce.
    ///
    /// `abc` is the SHA-256 test vector everyone publishes; the empty file is
    /// the other one. Both come from outside this codebase, which is what
    /// makes them worth asserting.
    #[test]
    fn hashes_match_the_published_vectors() {
        let folder = scratch("hash-vectors");

        let empty = folder.join("empty");
        std::fs::write(&empty, b"").expect("write");
        assert_eq!(
            sha256_file(&empty).expect("hash"),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );

        let abc = folder.join("abc");
        std::fs::write(&abc, b"abc").expect("write");
        assert_eq!(
            sha256_file(&abc).expect("hash"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// Guards the chunked read: a file larger than the 64 KiB buffer has to
    /// hash the same as one held in memory, or every large binary - which is
    /// all of the ones this exists for - would get a wrong answer.
    #[test]
    fn hashing_survives_more_than_one_chunk() {
        use sha2::{Digest, Sha256};

        let folder = scratch("hash-chunks");
        let file = folder.join("big");

        // Deliberately not a round multiple of the buffer, so the final short
        // read is exercised too.
        let bytes: Vec<u8> = (0..200_000u32).map(|index| (index % 251) as u8).collect();
        std::fs::write(&file, &bytes).expect("write");

        let expected = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(sha256_file(&file).expect("hash"), expected);
    }

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
