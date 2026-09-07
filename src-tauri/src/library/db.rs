//! The local download library: a SQLite record of everything ever downloaded.
//!
//! **Why this is app-side and not in the service.** The service's jobs are
//! in-memory and vanish on restart (SPEC §2); its integration doc offers two
//! ways to keep history, and this is the "persist a job mirror app-side" one.
//! It earns its place there because everything built on it is a desktop
//! concern the HTTP API has no business knowing about: where a file sits on
//! *this* machine, whether the user has since moved it, and what to show when
//! they have. The service stays the authority on downloading; this is the
//! authority on what the user ended up with.
//!
//! Nothing here reaches around the API. Rows are written from what the job
//! events already reported.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::error::{LibraryError, LibraryResult};
use super::signature::{signature, ALGORITHM};

/// Bumped whenever `migrate` gains a step. Stored in SQLite's own
/// `user_version`, so no bookkeeping table of our own is needed.
const SCHEMA_VERSION: i32 = 2;

/// What the UI shows for a row, and why an action might not be available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileState {
    /// The file was where the record says, last time anyone looked.
    Present,
    /// The path no longer resolves. The user moved, renamed or deleted it.
    Missing,
    /// The user pointed us at a replacement whose signature did not match.
    Mismatched,
    /// Never verified since it was recorded.
    Unknown,
}

impl FileState {
    fn as_str(self) -> &'static str {
        match self {
            FileState::Present => "present",
            FileState::Missing => "missing",
            FileState::Mismatched => "mismatched",
            FileState::Unknown => "unknown",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "present" => FileState::Present,
            "missing" => FileState::Missing,
            "mismatched" => FileState::Mismatched,
            _ => FileState::Unknown,
        }
    }
}

/// One completed download, as the library remembers it.
#[derive(Debug, Clone, Serialize)]
pub struct LibraryEntry {
    pub id: i64,
    pub job_id: String,
    pub url: String,
    pub title: Option<String>,
    pub channel: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub mode: Option<String>,
    pub format_summary: Option<String>,
    pub directory: Option<String>,
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<i64>,
    pub content_hash: Option<String>,
    pub hash_algorithm: Option<String>,
    pub state: FileState,
    pub downloaded_at: i64,
    pub verified_at: Option<i64>,
    /// The full normalised video metadata, as the service reported it.
    ///
    /// Kept verbatim rather than flattened into columns: the details view
    /// wants every field, extractors differ in which they report, and the
    /// service is free to add more. Stored as JSON so a new field needs no
    /// migration.
    pub video: Option<serde_json::Value>,
}

/// What happened when a download was deleted rather than merely forgotten.
#[derive(Debug, Clone, Serialize)]
pub struct Deletion {
    /// The file was removed from disk.
    pub deleted: bool,
    /// There was nothing to remove - already moved or deleted elsewhere.
    pub already_gone: bool,
    /// Why the file could not be removed; the record was kept if so.
    pub problem: Option<String>,
}

/// What the frontend sends after a job completes.
#[derive(Debug, Clone, Deserialize)]
pub struct RecordedDownload {
    pub job_id: String,
    pub url: String,
    pub title: Option<String>,
    pub channel: Option<String>,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub mode: Option<String>,
    pub format_summary: Option<String>,
    pub directory: Option<String>,
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    /// Everything `/api/v1/info` knew about the video, kept for the details
    /// view long after the service has forgotten the job.
    pub video: Option<serde_json::Value>,
}

pub struct Library {
    connection: Mutex<Connection>,
}

impl Library {
    pub fn open(path: &Path) -> LibraryResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| LibraryError::Open {
                message: format!("{}: {err}", parent.display()),
            })?;
        }

        let connection = Connection::open(path).map_err(|err| LibraryError::Open {
            message: format!("{}: {err}", path.display()),
        })?;

        // WAL keeps a read during a write from blocking, which matters because
        // verification runs while the UI is querying the same table.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;

        let library = Self {
            connection: Mutex::new(connection),
        };
        library.migrate()?;

        Ok(library)
    }

    pub fn open_in_memory() -> LibraryResult<Self> {
        let library = Self {
            connection: Mutex::new(Connection::open_in_memory().map_err(|err| {
                LibraryError::Open {
                    message: err.to_string(),
                }
            })?),
        };
        library.migrate()?;

        Ok(library)
    }

    fn with<T>(&self, run: impl FnOnce(&Connection) -> LibraryResult<T>) -> LibraryResult<T> {
        let guard = self.connection.lock().map_err(|_| LibraryError::Query {
            message: "the library lock was poisoned".into(),
        })?;

        run(&guard)
    }

    /// Stepwise so an existing database is upgraded rather than replaced.
    fn migrate(&self) -> LibraryResult<()> {
        self.with(|connection| {
            let version: i32 =
                connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

            if version < 1 {
                connection.execute_batch(
                    r#"
                    CREATE TABLE IF NOT EXISTS downloads (
                        id              INTEGER PRIMARY KEY AUTOINCREMENT,
                        job_id          TEXT    NOT NULL,
                        url             TEXT    NOT NULL,
                        title           TEXT,
                        channel         TEXT,
                        thumbnail       TEXT,
                        duration        REAL,
                        mode            TEXT,
                        format_summary  TEXT,
                        directory       TEXT,
                        file_path       TEXT,
                        file_name       TEXT,
                        size            INTEGER,
                        content_hash    TEXT,
                        hash_algorithm  TEXT,
                        state           TEXT    NOT NULL DEFAULT 'unknown',
                        downloaded_at   INTEGER NOT NULL,
                        verified_at     INTEGER
                    );

                    -- A job is recorded once; a re-run of the same job_id
                    -- updates the row rather than growing a duplicate.
                    CREATE UNIQUE INDEX IF NOT EXISTS downloads_job_id
                        ON downloads (job_id);

                    -- The two orders the library is ever read in.
                    CREATE INDEX IF NOT EXISTS downloads_downloaded_at
                        ON downloads (downloaded_at DESC);
                    CREATE INDEX IF NOT EXISTS downloads_state
                        ON downloads (state);
                    "#,
                )?;
            }

            if version < 2 {
                // Added so a finished download can still show its full details
                // once the service has forgotten the job.
                connection.execute_batch(
                    "ALTER TABLE downloads ADD COLUMN video_json TEXT;",
                )?;
            }

            connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;

            Ok(())
        })
    }

    /// Record a finished download, hashing the file so it can be recognised
    /// again if it moves. Re-recording the same `job_id` updates in place.
    pub fn record(&self, download: RecordedDownload) -> LibraryResult<LibraryEntry> {
        let now = unix_now();

        // Hashing is the one slow step, and it happens once, here - never on
        // the read path. A file that has already vanished is still recorded,
        // so the history is complete even when the artefact is not.
        let signed = download
            .file_path
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .and_then(|path| signature(path).ok());

        let (hash, size, state) = match signed {
            Some(sig) => (
                Some(sig.hash),
                Some(sig.size as i64),
                FileState::Present,
            ),
            None => (None, None, FileState::Missing),
        };

        self.with(|connection| {
            connection.execute(
                r#"
                INSERT INTO downloads (
                    job_id, url, title, channel, thumbnail, duration, mode,
                    format_summary, directory, file_path, file_name, size,
                    content_hash, hash_algorithm, state, downloaded_at,
                    verified_at, video_json
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18
                )
                ON CONFLICT (job_id) DO UPDATE SET
                    url            = excluded.url,
                    title          = excluded.title,
                    channel        = excluded.channel,
                    thumbnail      = excluded.thumbnail,
                    duration       = excluded.duration,
                    mode           = excluded.mode,
                    format_summary = excluded.format_summary,
                    directory      = excluded.directory,
                    file_path      = excluded.file_path,
                    file_name      = excluded.file_name,
                    size           = excluded.size,
                    content_hash   = excluded.content_hash,
                    hash_algorithm = excluded.hash_algorithm,
                    state          = excluded.state,
                    verified_at    = excluded.verified_at,
                    video_json     = excluded.video_json
                "#,
                params![
                    download.job_id,
                    download.url,
                    download.title,
                    download.channel,
                    download.thumbnail,
                    download.duration,
                    download.mode,
                    download.format_summary,
                    download.directory,
                    download.file_path,
                    download.file_name,
                    size,
                    hash,
                    hash.as_ref().map(|_| ALGORITHM),
                    state.as_str(),
                    now,
                    Some(now),
                    download
                        .video
                        .as_ref()
                        .and_then(|value| serde_json::to_string(value).ok()),
                ],
            )?;

            fetch_by_job(connection, &download.job_id)
        })
    }

    pub fn list(&self, limit: u32) -> LibraryResult<Vec<LibraryEntry>> {
        self.with(|connection| {
            let mut statement = connection.prepare(
                "SELECT * FROM downloads ORDER BY downloaded_at DESC, id DESC LIMIT ?1",
            )?;
            let rows = statement
                .query_map(params![limit], |row| Ok(read_entry(row)))?
                .collect::<Result<Vec<_>, _>>()?;

            Ok(rows)
        })
    }

    pub fn get(&self, id: i64) -> LibraryResult<LibraryEntry> {
        self.with(|connection| {
            connection
                .query_row("SELECT * FROM downloads WHERE id = ?1", params![id], |row| {
                    Ok(read_entry(row))
                })
                .optional()?
                .ok_or(LibraryError::NotFound)
        })
    }

    /// Check whether the file is still where the record says.
    ///
    /// Cheap on purpose: an existence and length check, no hashing. This is
    /// what runs when a menu opens, so it must not touch the file's contents.
    pub fn verify(&self, id: i64) -> LibraryResult<LibraryEntry> {
        let entry = self.get(id)?;

        let present = entry
            .file_path
            .as_deref()
            .map(Path::new)
            .is_some_and(|path| path.is_file());

        let state = if present {
            // A file that came back after being marked missing is present
            // again; a mismatch the user accepted is left alone.
            match entry.state {
                FileState::Mismatched => FileState::Mismatched,
                _ => FileState::Present,
            }
        } else {
            FileState::Missing
        };

        self.set_state(id, state)
    }

    fn set_state(&self, id: i64, state: FileState) -> LibraryResult<LibraryEntry> {
        self.with(|connection| {
            connection.execute(
                "UPDATE downloads SET state = ?1, verified_at = ?2 WHERE id = ?3",
                params![state.as_str(), unix_now(), id],
            )?;

            connection
                .query_row("SELECT * FROM downloads WHERE id = ?1", params![id], |row| {
                    Ok(read_entry(row))
                })
                .optional()?
                .ok_or(LibraryError::NotFound)
        })
    }

    /// Point a record at a file the user located, and say whether it is the
    /// same one. A mismatch is recorded, not rejected - it is the user's file
    /// and their call, but they get told.
    /// Whether `path` is the file this entry recorded, without changing
    /// anything.
    ///
    /// Split out from [`relocate`](Self::relocate) so the caller can ask
    /// before committing: a file that does not match is a question for the
    /// user, not something to apply and report afterwards.
    pub fn matches(&self, id: i64, path: &Path) -> LibraryResult<bool> {
        let entry = self.get(id)?;

        Ok(self.compare(&entry, &signature(path)?.hash))
    }

    /// Only a signature made the same way is comparable. An entry recorded
    /// before any hash existed cannot be checked, so it is never called a
    /// mismatch - claiming one would be an accusation we cannot support.
    fn compare(&self, entry: &LibraryEntry, hash: &str) -> bool {
        let comparable = entry.hash_algorithm.as_deref() == Some(ALGORITHM);

        match (comparable, entry.content_hash.as_deref()) {
            (true, Some(known)) => known == hash,
            _ => true,
        }
    }

    pub fn relocate(&self, id: i64, path: &Path) -> LibraryResult<(LibraryEntry, bool)> {
        let entry = self.get(id)?;
        let signed = signature(path)?;
        let matches = self.compare(&entry, &signed.hash);

        let state = if matches {
            FileState::Present
        } else {
            FileState::Mismatched
        };

        let updated = self.with(|connection| {
            connection.execute(
                r#"
                UPDATE downloads
                   SET file_path = ?1,
                       file_name = ?2,
                       directory = ?3,
                       size      = ?4,
                       state     = ?5,
                       verified_at = ?6
                 WHERE id = ?7
                "#,
                params![
                    path.to_string_lossy(),
                    path.file_name().map(|name| name.to_string_lossy().into_owned()),
                    path.parent().map(|dir| dir.to_string_lossy().into_owned()),
                    signed.size as i64,
                    state.as_str(),
                    unix_now(),
                    id,
                ],
            )?;

            connection
                .query_row("SELECT * FROM downloads WHERE id = ?1", params![id], |row| {
                    Ok(read_entry(row))
                })
                .optional()?
                .ok_or(LibraryError::NotFound)
        })?;

        Ok((updated, matches))
    }

    /// Drop the record. The file on disk is left exactly where it is.
    pub fn forget(&self, id: i64) -> LibraryResult<()> {
        self.with(|connection| {
            connection.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;

            Ok(())
        })
    }

    /// Delete the file *and* the record.
    ///
    /// The library's path is the authority here rather than the job's: after a
    /// relocate the file is wherever the user put it, and that is the copy
    /// they mean. A file that has already gone is not an error - the record
    /// still goes, which is what was asked for either way.
    pub fn delete(&self, id: i64) -> LibraryResult<Deletion> {
        let entry = self.get(id)?;

        let path = entry.file_path.as_deref().map(Path::new);
        let outcome = match path {
            Some(path) if path.is_file() => match std::fs::remove_file(path) {
                Ok(()) => Deletion {
                    deleted: true,
                    already_gone: false,
                    problem: None,
                },
                Err(err) => {
                    // Say so rather than pretending: the record is kept, so
                    // they can try again or remove it by hand.
                    return Ok(Deletion {
                        deleted: false,
                        already_gone: false,
                        problem: Some(format!("{}: {err}", path.display())),
                    });
                }
            },
            _ => Deletion {
                deleted: false,
                already_gone: true,
                problem: None,
            },
        };

        self.forget(id)?;

        Ok(outcome)
    }

    /// Total rows and how many are known to be missing, for a summary line.
    pub fn counts(&self) -> LibraryResult<(i64, i64)> {
        self.with(|connection| {
            let total: i64 =
                connection.query_row("SELECT COUNT(*) FROM downloads", [], |row| row.get(0))?;
            let missing: i64 = connection.query_row(
                "SELECT COUNT(*) FROM downloads WHERE state = 'missing'",
                [],
                |row| row.get(0),
            )?;

            Ok((total, missing))
        })
    }
}

fn fetch_by_job(connection: &Connection, job_id: &str) -> LibraryResult<LibraryEntry> {
    connection
        .query_row(
            "SELECT * FROM downloads WHERE job_id = ?1",
            params![job_id],
            |row| Ok(read_entry(row)),
        )
        .optional()?
        .ok_or(LibraryError::NotFound)
}

fn read_entry(row: &rusqlite::Row<'_>) -> LibraryEntry {
    let state: String = row.get("state").unwrap_or_else(|_| "unknown".into());

    LibraryEntry {
        id: row.get("id").unwrap_or_default(),
        job_id: row.get("job_id").unwrap_or_default(),
        url: row.get("url").unwrap_or_default(),
        title: row.get("title").ok(),
        channel: row.get("channel").ok(),
        thumbnail: row.get("thumbnail").ok(),
        duration: row.get("duration").ok(),
        mode: row.get("mode").ok(),
        format_summary: row.get("format_summary").ok(),
        directory: row.get("directory").ok(),
        file_path: row.get("file_path").ok(),
        file_name: row.get("file_name").ok(),
        size: row.get("size").ok(),
        content_hash: row.get("content_hash").ok(),
        hash_algorithm: row.get("hash_algorithm").ok(),
        state: FileState::parse(&state),
        downloaded_at: row.get("downloaded_at").unwrap_or_default(),
        verified_at: row.get("verified_at").ok(),
        // A row written before the column existed simply has none.
        video: row
            .get::<_, Option<String>>("video_json")
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok()),
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("inferno-lib-{name}"));
        let mut file = std::fs::File::create(&path).expect("creates");
        file.write_all(bytes).expect("writes");
        path
    }

    fn sample(job: &str, path: Option<&Path>) -> RecordedDownload {
        RecordedDownload {
            job_id: job.into(),
            url: "https://x.test/watch?v=1".into(),
            title: Some("A video".into()),
            channel: Some("A channel".into()),
            thumbnail: None,
            duration: Some(12.5),
            mode: Some("video".into()),
            format_summary: Some("MP4 1080p".into()),
            directory: path.and_then(|p| p.parent()).map(|d| d.display().to_string()),
            file_path: path.map(|p| p.display().to_string()),
            file_name: path
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned()),
            video: Some(serde_json::json!({
                "title": "A video",
                "channel": "A channel",
                "view_count": 1234,
            })),
        }
    }

    #[test]
    fn a_recorded_download_is_present_and_hashed() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("record.mp4", b"some video bytes");

        let entry = library.record(sample("job-1", Some(&file))).unwrap();

        assert_eq!(entry.state, FileState::Present);
        assert_eq!(entry.hash_algorithm.as_deref(), Some(ALGORITHM));
        assert!(entry.content_hash.is_some());
        assert_eq!(entry.size, Some(16));
    }

    #[test]
    fn recording_the_same_job_twice_updates_rather_than_duplicates() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("dup.mp4", b"bytes");

        library.record(sample("job-dup", Some(&file))).unwrap();
        let mut second = sample("job-dup", Some(&file));
        second.title = Some("Renamed".into());
        let entry = library.record(second).unwrap();

        assert_eq!(entry.title.as_deref(), Some("Renamed"));
        assert_eq!(library.counts().unwrap().0, 1);
    }

    #[test]
    fn a_download_whose_file_never_arrived_is_still_recorded() {
        // History stays complete even when the artefact is not.
        let library = Library::open_in_memory().unwrap();
        let entry = library
            .record(sample("job-gone", Some(Path::new("Z:\\nope\\gone.mp4"))))
            .unwrap();

        assert_eq!(entry.state, FileState::Missing);
        assert!(entry.content_hash.is_none());
    }

    #[test]
    fn verify_notices_a_deleted_file_and_notices_it_coming_back() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("vanish.mp4", b"here for now");
        let entry = library.record(sample("job-v", Some(&file))).unwrap();
        assert_eq!(entry.state, FileState::Present);

        std::fs::remove_file(&file).unwrap();
        assert_eq!(library.verify(entry.id).unwrap().state, FileState::Missing);

        // Put it back: the library should stop complaining.
        temp_file("vanish.mp4", b"here for now");
        assert_eq!(library.verify(entry.id).unwrap().state, FileState::Present);
    }

    #[test]
    fn relocating_to_the_same_content_matches() {
        let library = Library::open_in_memory().unwrap();
        let original = temp_file("move-from.mp4", b"identical content");
        let entry = library.record(sample("job-m", Some(&original))).unwrap();

        let moved = temp_file("move-to.mp4", b"identical content");
        let (updated, matched) = library.relocate(entry.id, &moved).unwrap();

        assert!(matched, "same bytes must be recognised");
        assert_eq!(updated.state, FileState::Present);
        assert_eq!(updated.file_path.as_deref(), Some(moved.display().to_string().as_str()));
    }

    #[test]
    fn matches_answers_without_changing_anything() {
        // The check the locate flow runs before committing: it must not touch
        // the record, or a rejected candidate would still have been applied.
        let library = Library::open_in_memory().unwrap();
        let original = temp_file("cmp-from.mp4", b"the original bytes");
        let entry = library.record(sample("job-cmp", Some(&original))).unwrap();

        let same = temp_file("cmp-same.mp4", b"the original bytes");
        let other = temp_file("cmp-other.mp4", b"something else entirely");

        assert!(library.matches(entry.id, &same).unwrap());
        assert!(!library.matches(entry.id, &other).unwrap());

        // Untouched by either question.
        let after = library.get(entry.id).unwrap();
        assert_eq!(after.state, FileState::Present);
        assert_eq!(after.file_path, entry.file_path);
    }

    #[test]
    fn an_entry_with_no_signature_cannot_be_called_a_mismatch() {
        // Recorded before the file existed, so there is nothing to compare.
        let library = Library::open_in_memory().unwrap();
        let entry = library
            .record(sample("job-nohash", Some(Path::new(r"Z:\nope\gone.mp4"))))
            .unwrap();
        assert!(entry.content_hash.is_none());

        let anything = temp_file("cmp-anything.mp4", b"whatever");
        assert!(library.matches(entry.id, &anything).unwrap());
    }

    #[test]
    fn relocating_to_different_content_is_recorded_as_a_mismatch() {
        let library = Library::open_in_memory().unwrap();
        let original = temp_file("mm-from.mp4", b"the original bytes");
        let entry = library.record(sample("job-mm", Some(&original))).unwrap();

        let other = temp_file("mm-to.mp4", b"a completely different file");
        let (updated, matched) = library.relocate(entry.id, &other).unwrap();

        assert!(!matched, "different bytes must be reported");
        assert_eq!(updated.state, FileState::Mismatched);
        // Still relocated: it is the user's file and their call.
        assert_eq!(updated.file_path.as_deref(), Some(other.display().to_string().as_str()));
    }

    #[test]
    fn a_mismatch_survives_a_later_verify() {
        // Verify is only an existence check, so it must not quietly upgrade a
        // file the user was already warned about.
        let library = Library::open_in_memory().unwrap();
        let original = temp_file("keep-from.mp4", b"original");
        let entry = library.record(sample("job-k", Some(&original))).unwrap();
        let other = temp_file("keep-to.mp4", b"different entirely");
        library.relocate(entry.id, &other).unwrap();

        assert_eq!(
            library.verify(entry.id).unwrap().state,
            FileState::Mismatched
        );
    }

    #[test]
    fn the_listing_is_newest_first_and_forget_removes() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("list.mp4", b"x");
        let a = library.record(sample("job-a", Some(&file))).unwrap();
        let b = library.record(sample("job-b", Some(&file))).unwrap();

        let listed = library.list(10).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, b.id, "newest first");

        library.forget(a.id).unwrap();
        assert_eq!(library.counts().unwrap().0, 1);
        assert!(matches!(library.get(a.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn delete_removes_the_file_and_the_record() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("delete-me.mp4", b"payload");
        let entry = library.record(sample("job-del", Some(&file))).unwrap();

        let outcome = library.delete(entry.id).unwrap();

        assert!(outcome.deleted);
        assert!(outcome.problem.is_none());
        assert!(!file.exists(), "the file is gone from disk");
        assert!(matches!(library.get(entry.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn forget_leaves_the_file_alone() {
        // The distinction the two menu entries rest on.
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("keep-me.mp4", b"payload");
        let entry = library.record(sample("job-keep", Some(&file))).unwrap();

        library.forget(entry.id).unwrap();

        assert!(file.is_file(), "forget must never touch the file");
        assert!(matches!(library.get(entry.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn deleting_an_already_missing_file_still_drops_the_record() {
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("vanished.mp4", b"payload");
        let entry = library.record(sample("job-vanished", Some(&file))).unwrap();
        std::fs::remove_file(&file).unwrap();

        let outcome = library.delete(entry.id).unwrap();

        assert!(!outcome.deleted);
        assert!(outcome.already_gone);
        assert!(matches!(library.get(entry.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn delete_follows_a_relocation_rather_than_the_original_path() {
        // After a relocate the file is wherever the user put it, and that is
        // the copy "delete" means - not the path it was downloaded to.
        let library = Library::open_in_memory().unwrap();
        let original = temp_file("moved-from.mp4", b"same bytes");
        let entry = library.record(sample("job-moved", Some(&original))).unwrap();

        let moved = temp_file("moved-to.mp4", b"same bytes");
        library.relocate(entry.id, &moved).unwrap();

        let outcome = library.delete(entry.id).unwrap();

        assert!(outcome.deleted);
        assert!(!moved.exists(), "the relocated file is the one removed");
    }

    #[test]
    fn the_full_video_metadata_survives_a_round_trip() {
        // The details view needs every field the service reported, long after
        // the service has forgotten the job.
        let library = Library::open_in_memory().unwrap();
        let file = temp_file("video-json.mp4", b"x");
        let entry = library.record(sample("job-video", Some(&file))).unwrap();

        let video = entry.video.expect("video metadata was stored");
        assert_eq!(video["title"], "A video");
        assert_eq!(video["view_count"], 1234);

        // And it comes back through a plain read, not just the write's echo.
        let reread = library.get(entry.id).unwrap();
        assert_eq!(reread.video.unwrap()["channel"], "A channel");
    }

    #[test]
    fn a_v1_database_migrates_without_losing_rows() {
        // Someone upgrading has a v1 file already; the new column must be
        // added around their data, not instead of it.
        let path = std::env::temp_dir().join("inferno-lib-v1.sqlite3");
        let _ = std::fs::remove_file(&path);

        {
            let connection = rusqlite::Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE downloads (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        job_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT,
                        channel TEXT, thumbnail TEXT, duration REAL, mode TEXT,
                        format_summary TEXT, directory TEXT, file_path TEXT,
                        file_name TEXT, size INTEGER, content_hash TEXT,
                        hash_algorithm TEXT, state TEXT NOT NULL DEFAULT 'unknown',
                        downloaded_at INTEGER NOT NULL, verified_at INTEGER);
                     INSERT INTO downloads (job_id, url, title, state, downloaded_at)
                        VALUES ('old-job', 'https://x.test/1', 'From v1', 'present', 1);
                     PRAGMA user_version = 1;",
                )
                .unwrap();
        }

        let library = Library::open(&path).unwrap();
        let rows = library.list(10).unwrap();
        assert_eq!(rows.len(), 1, "the existing row survived");
        assert_eq!(rows[0].title.as_deref(), Some("From v1"));
        // No metadata for it, but that is a missing value, not a failure.
        assert!(rows[0].video.is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_schema_version_is_stamped_and_reopening_is_safe() {
        let path = std::env::temp_dir().join("inferno-lib-reopen.sqlite3");
        let _ = std::fs::remove_file(&path);

        let file = temp_file("reopen.mp4", b"payload");
        {
            let library = Library::open(&path).unwrap();
            library.record(sample("job-persist", Some(&file))).unwrap();
        }

        // A second open must migrate cleanly and still see the row.
        let library = Library::open(&path).unwrap();
        assert_eq!(library.counts().unwrap().0, 1);
        let version: i32 = library
            .with(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let _ = std::fs::remove_file(&path);
    }
}
