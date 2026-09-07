//! Finding Spotify, its accounts, and the folders it watches for local files.
//!
//! Spotify does not publish any of this. What it does leave behind is a set of
//! per-account `.bnk` files - a binary format with no public schema - and
//! filesystem paths happen to sit inside them as plain text:
//!
//! * `watch-sources.bnk` - the folders the user added under "Local Files"
//! * `local-files.bnk`   - the tracks it actually indexed
//!
//! So this does not parse the format. It scans for anything that *looks* like a
//! path, then asks the filesystem whether it is one, which is the only check
//! that means anything. A false positive fails that test and disappears; a
//! false negative costs nothing, because the user picks the folder from a list
//! and can always be told to add one in Spotify.
//!
//! Ported from a Python probe that used regular expressions over the same
//! files. The scanning here is hand-written: the crate has no `regex`
//! dependency, and a path scanner is a few lines of character matching.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Extensions Spotify will actually index. Anything else in a watched folder
/// is not a local file as far as it is concerned.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "m4p", "mp4", "flac", "ogg", "wav", "aac", "wma",
];

/// Characters that cannot appear in a Windows path, so a run of path-ish text
/// ends at the first one. Quotes and angle brackets are the useful ones - a
/// `.bnk` is binary, so a captured run usually ends in something illegal.
fn ends_path(c: char) -> bool {
    c.is_control() || matches!(c, '"' | '*' | '?' | '<' | '>' | '|' | '\r' | '\n')
}

/// Two readings of the same bytes.
///
/// Spotify writes some strings as UTF-8 and some as UTF-16LE, in the same file,
/// so both are scanned and the results merged. Decoding lossily is deliberate:
/// the surrounding bytes are not text at all, and the replacement characters
/// they turn into are exactly the terminators the scan is looking for.
fn readings(blob: &[u8]) -> Vec<String> {
    let mut out = vec![String::from_utf8_lossy(blob).into_owned()];

    // Both alignments: a UTF-16 string is not guaranteed to start on an even
    // offset within the file.
    for skip in [0usize, 1] {
        if blob.len() > skip {
            let units: Vec<u16> = blob[skip..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            out.push(String::from_utf16_lossy(&units));
        }
    }

    out
}

/// Undo `%20`-style escaping, which Spotify applies to some stored paths.
fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }

    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Tidy a captured run into something worth testing against the filesystem.
fn normalise(raw: &str) -> String {
    let stripped = raw
        .trim_start_matches("file:///")
        .trim_start_matches("file://")
        .trim_start_matches("file:/");
    let decoded = percent_decode(stripped);

    // Doubled separators come from escaping in the stored form.
    decoded
        .replace("\\\\", "\\")
        .trim_end_matches(['\\', '/', ' ', '\t', '"', '\'', ',', ';', ')'])
        .to_owned()
}

/// Every drive-letter path in one reading of the bytes.
///
/// Only `X:\` and `X:/` starts. UNC paths are deliberately not scanned for:
/// Spotify cannot index a network share as a local file, so anything matching
/// would be noise.
fn candidates(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut found = Vec::new();
    let mut i = 0;

    while i + 2 < chars.len() {
        let looks_like_drive = chars[i].is_ascii_alphabetic()
            && chars[i + 1] == ':'
            && (chars[i + 2] == '\\' || chars[i + 2] == '/');

        if !looks_like_drive {
            i += 1;
            continue;
        }

        let start = i;
        let mut end = i + 2;
        while end < chars.len() && !ends_path(chars[end]) {
            end += 1;
        }

        let run: String = chars[start..end].iter().collect();
        if run.len() > 3 {
            found.push(run);
        }

        i = end.max(start + 1);
    }

    found
}

/// The deepest part of a candidate that actually exists.
///
/// A captured run usually has binary junk welded onto the end, so this walks up
/// until the filesystem recognises something. Returns whether it landed on a
/// file, since a track and a folder mean different things to the caller.
fn resolve(candidate: &str) -> Option<(PathBuf, bool)> {
    let mut path = PathBuf::from(candidate);

    // A drive root is not an answer; stop before claiming `C:\` is a music
    // folder just because it exists.
    for _ in 0..12 {
        if path.components().count() < 2 {
            return None;
        }
        if path.is_file() {
            return Some((path, true));
        }
        if path.is_dir() {
            return Some((path, false));
        }

        path = path.parent()?.to_path_buf();
    }

    None
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// How many playable files a folder holds, capped so a huge library does not
/// stall the probe.
fn audio_count(path: &Path) -> u32 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };

    entries
        .take(4000)
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file() && is_audio(&entry.path()))
        .count() as u32
}

/// Where Spotify keeps per-user state, for every way it can be installed.
///
/// The two Windows builds put it in completely different places: the installer
/// build under Roaming, the Store build inside its sandboxed package. A machine
/// can have both, which is the whole reason the user is asked to pick one.
pub fn roots() -> Vec<(SpotifyKind, PathBuf)> {
    let mut found = Vec::new();

    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = PathBuf::from(appdata).join("Spotify");
        if path.is_dir() {
            found.push((SpotifyKind::Desktop, path));
        }
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let packages = PathBuf::from(local).join("Packages");
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("SpotifyAB.SpotifyMusic_") {
                    continue;
                }

                let path = entry.path().join("LocalState").join("Spotify");
                if path.is_dir() {
                    found.push((SpotifyKind::MicrosoftStore, path));
                }
            }
        }
    }

    found
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpotifyKind {
    Desktop,
    MicrosoftStore,
}

impl SpotifyKind {
    fn label(self) -> &'static str {
        match self {
            Self::Desktop => "Spotify (installer)",
            Self::MicrosoftStore => "Spotify (Microsoft Store)",
        }
    }
}

/// A folder Spotify is watching, or has indexed something from.
#[derive(Debug, Clone, Serialize)]
pub struct LocalFolder {
    pub path: String,
    /// It can be listed and gone - a removed drive, a deleted folder.
    pub exists: bool,
    /// Playable files sitting in it now, whatever Spotify thinks.
    pub audio_files: u32,
    /// Tracks Spotify has indexed from it. Zero means it is configured but
    /// empty, which is still a perfectly good place to put new downloads.
    pub indexed_tracks: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpotifyAccount {
    pub user_id: String,
    pub profile_dir: String,
    pub folders: Vec<LocalFolder>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpotifyInstallation {
    /// The root path - stable across restarts, so settings can store it.
    pub id: String,
    pub kind: SpotifyKind,
    pub label: String,
    pub accounts: Vec<SpotifyAccount>,
}

/// Read one account's banks and collect the folders they mention.
fn survey(profile_dir: &Path) -> Vec<LocalFolder> {
    // Ordered so the list the user sees is stable between runs.
    let mut folders: BTreeSet<PathBuf> = BTreeSet::new();
    // Tracks are collected as a set before being counted. The same file turns
    // up in more than one reading of the bytes - a path that is legible as
    // UTF-8 is often legible again at a UTF-16 alignment - so counting as they
    // arrive reported twice as many indexed tracks as Spotify actually has.
    let mut tracks: BTreeSet<PathBuf> = BTreeSet::new();

    let Ok(entries) = std::fs::read_dir(profile_dir) else {
        return Vec::new();
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(OsStr::to_str) != Some("bnk") {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        // Only the two banks that describe local files. The others hold ad
        // state and playback history, which would just add noise.
        let watches = name.contains("watch-source");
        let indexes = name.contains("local-file");
        if !watches && !indexes {
            continue;
        }

        let Ok(blob) = std::fs::read(&path) else {
            continue;
        };

        for text in readings(&blob) {
            for candidate in candidates(&text) {
                let Some((resolved, is_file)) = resolve(&normalise(&candidate)) else {
                    continue;
                };

                if is_file {
                    // A track counts towards the folder holding it.
                    if is_audio(&resolved) {
                        if let Some(parent) = resolved.parent() {
                            folders.insert(parent.to_path_buf());
                        }
                        tracks.insert(resolved);
                    }
                } else {
                    folders.insert(resolved);
                }
            }
        }
    }

    let mut folders: Vec<LocalFolder> = folders
        .into_iter()
        .map(|path| LocalFolder {
            exists: path.is_dir(),
            audio_files: audio_count(&path),
            indexed_tracks: tracks
                .iter()
                .filter(|track| track.parent() == Some(path.as_path()))
                .count() as u32,
            path: path.to_string_lossy().into_owned(),
        })
        .collect();

    // Most-used first: the folder someone already keeps music in is the one
    // they almost certainly mean.
    folders.sort_by(|a, b| {
        b.indexed_tracks
            .cmp(&a.indexed_tracks)
            .then_with(|| a.path.cmp(&b.path))
    });

    folders
}

/// Every Spotify install on this machine, with its accounts and their folders.
pub fn installations() -> Vec<SpotifyInstallation> {
    roots()
        .into_iter()
        .map(|(kind, root)| {
            let mut accounts = Vec::new();

            if let Ok(entries) = std::fs::read_dir(root.join("Users")) {
                for entry in entries.filter_map(Result::ok) {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    // Profile directories are `<user id>-user`.
                    let Some(user_id) = name.strip_suffix("-user") else {
                        continue;
                    };
                    if !entry.path().is_dir() {
                        continue;
                    }

                    accounts.push(SpotifyAccount {
                        user_id: user_id.to_owned(),
                        folders: survey(&entry.path()),
                        profile_dir: entry.path().to_string_lossy().into_owned(),
                    });
                }
            }

            accounts.sort_by(|a, b| a.user_id.cmp(&b.user_id));

            SpotifyInstallation {
                id: root.to_string_lossy().into_owned(),
                kind,
                label: kind.label().to_owned(),
                accounts,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drive_path_is_found_in_utf8_noise() {
        let blob = b"\x01\x02rubbishC:\\Users\\me\\Music\\track.mp3\x00\x00more";
        let text = &readings(blob)[0];
        let found = candidates(text);

        assert!(
            found.iter().any(|c| c.contains("Music")),
            "expected a path, got {found:?}"
        );
    }

    #[test]
    fn a_run_stops_at_the_first_illegal_character() {
        let found = candidates("C:\\Music\\ok\"then junk");
        assert_eq!(found, vec!["C:\\Music\\ok".to_string()]);
    }

    #[test]
    fn percent_escapes_are_undone() {
        assert_eq!(percent_decode("C:%5CMy%20Music"), "C:\\My Music");
        // Text with no escapes is returned untouched rather than rebuilt.
        assert_eq!(percent_decode("C:\\plain"), "C:\\plain");
    }

    #[test]
    fn a_file_url_loses_its_scheme() {
        assert_eq!(normalise("file:///C:/Music/a.mp3"), "C:/Music/a.mp3");
        assert_eq!(normalise("C:\\\\Music\\\\a.mp3"), "C:\\Music\\a.mp3");
    }

    #[test]
    fn resolving_walks_up_to_something_real() {
        let here = std::env::current_dir().expect("a working directory");
        let buried = here.join("no-such-folder").join("no-such-file.mp3");

        let (found, is_file) =
            resolve(&buried.to_string_lossy()).expect("an ancestor exists");
        assert_eq!(found, here);
        assert!(!is_file);
    }

    #[test]
    fn a_bare_drive_is_not_an_answer() {
        // Walking up must not end at `C:\` and call it a music folder.
        assert!(resolve("Z:\\definitely\\not\\here").is_none());
    }

    #[test]
    fn audio_is_recognised_case_insensitively() {
        assert!(is_audio(Path::new("a.MP3")));
        assert!(is_audio(Path::new("a.flac")));
        assert!(!is_audio(Path::new("a.txt")));
        assert!(!is_audio(Path::new("a")));
    }
}

#[cfg(test)]
mod live {
    /// Prints what the probe finds on this machine. Ignored by default - it
    /// depends on a real Spotify install, so it is a diagnostic rather than a
    /// test. Run with `cargo test -- --ignored --nocapture live_probe`.
    #[ignore]
    #[test]
    fn live_probe() {
        for install in super::installations() {
            println!("{} [{}]", install.label, install.id);
            for account in &install.accounts {
                println!("  account {}", account.user_id);
                for folder in &account.folders {
                    println!(
                        "    {} (exists={}, indexed={}, audio={})",
                        folder.path,
                        folder.exists,
                        folder.indexed_tracks,
                        folder.audio_files
                    );
                }
            }
        }
    }
}
