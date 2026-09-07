//! Identifying a downloaded file well enough to recognise it after a move.
//!
//! **Not a full-file hash, on purpose.** These are videos: hashing 2 GB to
//! answer "is this the same file?" would take seconds and be run every time
//! someone opens a menu. Instead the signature covers the exact byte length
//! plus the first and last 1 MiB, which is what actually distinguishes media
//! files - two different videos essentially never share a length *and* both
//! ends, while a re-encode or a truncated download differs immediately.
//!
//! What it deliberately does not do is prove a file is untampered. It answers
//! "did the user point me at the same download?", not "is this authentic".

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::error::{LibraryError, LibraryResult};

/// How much of each end goes into the signature.
const WINDOW: u64 = 1024 * 1024;

/// Bumped if the scheme below ever changes, so an old signature is recognised
/// as incomparable rather than silently reported as a mismatch.
pub const ALGORITHM: &str = "sha256-ends-v1";

pub struct Signature {
    pub hash: String,
    pub size: u64,
}

/// Hash a file's length and both ends.
pub fn signature(path: &Path) -> LibraryResult<Signature> {
    let mut file = File::open(path).map_err(|err| LibraryError::Io {
        message: format!("{}: {err}", path.display()),
    })?;
    let size = file
        .metadata()
        .map_err(|err| LibraryError::Io {
            message: err.to_string(),
        })?
        .len();

    let mut hasher = Sha256::new();
    // The length goes in first: two files sharing both ends but differing in
    // the middle are still told apart by it, and it makes a truncated download
    // impossible to confuse with the finished one.
    hasher.update(size.to_le_bytes());

    let window = WINDOW.min(size);
    let mut buffer = vec![0u8; window as usize];

    if window > 0 {
        file.read_exact(&mut buffer).map_err(read_error(path))?;
        hasher.update(&buffer);

        // Only hash the tail when the file is big enough for it to be a
        // different region; otherwise the head already covered everything.
        if size > window * 2 {
            file.seek(SeekFrom::End(-(window as i64)))
                .map_err(read_error(path))?;
            file.read_exact(&mut buffer).map_err(read_error(path))?;
            hasher.update(&buffer);
        }
    }

    Ok(Signature {
        hash: format!("{:x}", hasher.finalize()),
        size,
    })
}

fn read_error(path: &Path) -> impl Fn(std::io::Error) -> LibraryError + '_ {
    move |err| LibraryError::Io {
        message: format!("could not read {}: {err}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("inferno-sig-{name}"));
        let mut file = File::create(&path).expect("creates");
        file.write_all(bytes).expect("writes");
        path
    }

    #[test]
    fn the_same_bytes_give_the_same_signature() {
        let a = write("same-a", b"hello world, this is a little file");
        let b = write("same-b", b"hello world, this is a little file");
        assert_eq!(
            signature(&a).unwrap().hash,
            signature(&b).unwrap().hash,
            "identical content must match"
        );
    }

    #[test]
    fn different_content_of_the_same_length_differs() {
        let a = write("len-a", b"aaaaaaaaaaaaaaaa");
        let b = write("len-b", b"aaaaaaaaaaaaaaab");
        assert_ne!(signature(&a).unwrap().hash, signature(&b).unwrap().hash);
    }

    #[test]
    fn a_truncated_file_never_matches_the_whole_one() {
        // The realistic failure: a download that was interrupted, or a file
        // the user replaced with a shorter cut.
        let whole = write("trunc-whole", &vec![7u8; 4096]);
        let cut = write("trunc-cut", &vec![7u8; 2048]);
        assert_ne!(
            signature(&whole).unwrap().hash,
            signature(&cut).unwrap().hash
        );
    }

    #[test]
    fn an_empty_file_still_signs() {
        let empty = write("empty", b"");
        let sig = signature(&empty).unwrap();
        assert_eq!(sig.size, 0);
        assert!(!sig.hash.is_empty());
    }

    #[test]
    fn a_file_larger_than_both_windows_hashes_both_ends() {
        // Differs only in its final bytes, which a head-only hash would miss.
        let mut head_and_tail = vec![3u8; (WINDOW * 2 + 4096) as usize];
        let mut same_head = head_and_tail.clone();
        let last = same_head.len() - 1;
        same_head[last] = 9;

        head_and_tail[0] = 3;
        let a = write("ends-a", &head_and_tail);
        let b = write("ends-b", &same_head);
        assert_ne!(signature(&a).unwrap().hash, signature(&b).unwrap().hash);
    }

    #[test]
    fn a_missing_file_is_an_error() {
        assert!(signature(Path::new("Z:\\nope\\missing.mp4")).is_err());
    }
}
