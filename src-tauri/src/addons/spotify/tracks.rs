//! Reading enough tags out of an audio file to list it usefully.
//!
//! Two container families cover everything Spotify will play, and they store
//! metadata in completely different ways:
//!
//! * **ID3v2**, at the front of an MP3 - a header, then tagged frames.
//! * **MP4 atoms**, in an `m4a`/`mp4`/`m4p` - a tree, with the tags buried at
//!   `moov/udta/meta/ilst`.
//!
//! Both are read here directly rather than through a crate. What is needed is
//! four strings and a picture, and pulling in a full tag library for that would
//! be a large dependency for a settings dialog.
//!
//! Nothing here is fatal. A file with no tags, a truncated header, a format
//! that was never understood - all of it falls back to the filename, because a
//! list that silently drops the files it could not parse is worse than one
//! that shows them plainly.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// The most one cover may weigh.
///
/// Was 512 KB, which is squarely inside the range tag editors actually write -
/// a 537 KB PNG missed by thirteen kilobytes and showed as a blank square,
/// indistinguishable from a file that has no cover at all. Generous per image
/// now, with the listing as a whole bounded below instead.
const MAX_ARTWORK_BYTES: usize = 2 * 1024 * 1024;

/// ...and the most a whole listing may spend on covers.
///
/// A data URI is base64, so every cover costs a third more in the message than
/// it does on disk. This is the bound that matters: one heavy image is fine,
/// five hundred of them is a dialog that never opens. Tracks past it still
/// list - they simply list without art.
const MAX_ARTWORK_TOTAL: usize = 24 * 1024 * 1024;

/// Only the front of the file is read. ID3 headers live there, and an MP4's
/// `moov` atom is at the front in anything written for streaming.
const HEAD_BYTES: usize = 3 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Track {
    pub path: String,
    pub file_name: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// A `data:` URI, ready to put straight in an `img` tag.
    pub artwork: Option<String>,
    pub size: u64,
    /// Seconds since the epoch, for "added" ordering.
    pub modified: Option<u64>,
}

// --- base64 -----------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Just enough base64 to build a `data:` URI. Standard alphabet, padded.
fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;

        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }

    out
}

fn data_uri(mime: &str, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_ARTWORK_BYTES {
        return None;
    }

    let mime = if mime.is_empty() { "image/jpeg" } else { mime };

    Some(format!("data:{mime};base64,{}", base64(bytes)))
}

// --- ID3v2 ------------------------------------------------------------------

/// ID3 sizes are "synchsafe": seven bits per byte, so the size can never
/// contain a byte that looks like the start of an audio frame.
fn synchsafe(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .fold(0usize, |acc, byte| (acc << 7) | (*byte as usize & 0x7F))
}

fn plain_u32(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .fold(0usize, |acc, byte| (acc << 8) | *byte as usize)
}

/// Decode a text frame's payload, which starts with an encoding byte.
fn id3_text(payload: &[u8]) -> Option<String> {
    let (encoding, rest) = payload.split_first()?;

    let text = match encoding {
        // Latin-1.
        0 => rest.iter().map(|b| *b as char).collect::<String>(),
        // UTF-16 with a byte-order mark.
        1 => {
            if rest.len() < 2 {
                return None;
            }
            let big_endian = rest[0] == 0xFE && rest[1] == 0xFF;
            let units: Vec<u16> = rest[2..]
                .chunks_exact(2)
                .map(|pair| {
                    if big_endian {
                        u16::from_be_bytes([pair[0], pair[1]])
                    } else {
                        u16::from_le_bytes([pair[0], pair[1]])
                    }
                })
                .collect();
            String::from_utf16_lossy(&units)
        }
        // UTF-16BE, no mark.
        2 => {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        }
        // UTF-8.
        _ => String::from_utf8_lossy(rest).into_owned(),
    };

    let trimmed = text.trim_end_matches('\0').trim().to_owned();

    (!trimmed.is_empty()).then_some(trimmed)
}

/// Pull the cover out of an `APIC` frame.
///
/// Its layout is a run of variable-length fields: encoding byte, a
/// null-terminated MIME string, a picture-type byte, a description terminated
/// the same way the text is encoded, and then the image.
fn id3_picture(payload: &[u8]) -> Option<String> {
    let (encoding, rest) = payload.split_first()?;

    let mime_end = rest.iter().position(|b| *b == 0)?;
    let mime: String = rest[..mime_end].iter().map(|b| *b as char).collect();
    let after_mime = rest.get(mime_end + 1..)?;

    // Skip the picture-type byte, then the description.
    let after_type = after_mime.get(1..)?;
    let image = if *encoding == 1 || *encoding == 2 {
        // UTF-16 descriptions terminate with two zero bytes on an even offset.
        let mut i = 0;
        loop {
            if i + 1 >= after_type.len() {
                return None;
            }
            if after_type[i] == 0 && after_type[i + 1] == 0 {
                break after_type.get(i + 2..)?;
            }
            i += 2;
        }
    } else {
        let end = after_type.iter().position(|b| *b == 0)?;
        after_type.get(end + 1..)?
    };

    data_uri(&mime, image)
}

fn read_id3(blob: &[u8], track: &mut Track) {
    if blob.len() < 10 || &blob[0..3] != b"ID3" {
        return;
    }

    let major = blob[3];
    let tag_size = synchsafe(&blob[6..10]);
    let end = (10 + tag_size).min(blob.len());
    let mut at = 10usize;

    while at + 10 <= end {
        let id = &blob[at..at + 4];
        if id == [0, 0, 0, 0] {
            break;
        }

        // 2.4 made frame sizes synchsafe as well; 2.3 left them plain.
        let size = if major >= 4 {
            synchsafe(&blob[at + 4..at + 8])
        } else {
            plain_u32(&blob[at + 4..at + 8])
        };

        let start = at + 10;
        let finish = start.saturating_add(size);
        if size == 0 || finish > end {
            break;
        }

        let payload = &blob[start..finish];
        match id {
            b"TIT2" => track.title = id3_text(payload),
            b"TPE1" => track.artist = id3_text(payload),
            b"TALB" => track.album = id3_text(payload),
            b"APIC" => {
                if track.artwork.is_none() {
                    track.artwork = id3_picture(payload);
                }
            }
            _ => {}
        }

        at = finish;
    }
}

// --- MP4 --------------------------------------------------------------------

/// Walk the children of an atom, calling `visit` with each type and body.
fn mp4_children(blob: &[u8], mut visit: impl FnMut(&[u8; 4], &[u8])) {
    let mut at = 0usize;

    while at + 8 <= blob.len() {
        let size = plain_u32(&blob[at..at + 4]);
        let kind: [u8; 4] = [blob[at + 4], blob[at + 5], blob[at + 6], blob[at + 7]];

        // A size of 0 means "to the end"; anything under the header is corrupt.
        let end = if size == 0 {
            blob.len()
        } else if size < 8 {
            return;
        } else {
            (at + size).min(blob.len())
        };

        visit(&kind, &blob[at + 8..end]);

        if end <= at {
            return;
        }
        at = end;
    }
}

/// The payload of an `ilst` entry, which wraps its value in a `data` atom.
fn mp4_value(body: &[u8]) -> Option<(u32, Vec<u8>)> {
    let mut found = None;

    mp4_children(body, |kind, data| {
        if kind == b"data" && found.is_none() && data.len() > 8 {
            // Four bytes of type flags, four reserved, then the value.
            let flavour = plain_u32(&data[0..4]) as u32;
            found = Some((flavour, data[8..].to_vec()));
        }
    });

    found
}

fn read_mp4(blob: &[u8], track: &mut Track) {
    // moov -> udta -> meta -> ilst, with `meta` carrying four bytes of version
    // and flags before its children.
    let mut ilst: Option<Vec<u8>> = None;

    mp4_children(blob, |kind, moov| {
        if kind != b"moov" {
            return;
        }
        mp4_children(moov, |kind, udta| {
            if kind != b"udta" {
                return;
            }
            mp4_children(udta, |kind, meta| {
                if kind != b"meta" || meta.len() < 4 {
                    return;
                }
                mp4_children(&meta[4..], |kind, list| {
                    if kind == b"ilst" {
                        ilst = Some(list.to_vec());
                    }
                });
            });
        });
    });

    let Some(list) = ilst else {
        return;
    };

    mp4_children(&list, |kind, body| {
        let Some((flavour, value)) = mp4_value(body) else {
            return;
        };

        // Flavour 1 is UTF-8 text; 13 and 14 are JPEG and PNG artwork.
        let text = || {
            let s = String::from_utf8_lossy(&value).trim().to_owned();
            (!s.is_empty()).then_some(s)
        };

        match kind {
            // The `©` in these names is 0xA9 in MacRoman, not UTF-8.
            [0xA9, b'n', b'a', b'm'] if flavour == 1 => track.title = text(),
            [0xA9, b'A', b'R', b'T'] if flavour == 1 => track.artist = text(),
            [0xA9, b'a', b'l', b'b'] if flavour == 1 => track.album = text(),
            b"covr" if track.artwork.is_none() => {
                let mime = if flavour == 14 { "image/png" } else { "image/jpeg" };
                track.artwork = data_uri(mime, &value);
            }
            _ => {}
        }
    });
}

// --- the listing ------------------------------------------------------------

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Read one file's tags. Never fails - an unreadable file is still listed.
/// A folder's worth of tracks, sharing one artwork budget.
///
/// The budget lives here rather than inside `read_track` because it is a
/// property of the message being built, not of any one file.
pub fn read_tracks(paths: &[std::path::PathBuf]) -> Vec<Track> {
    let mut spent = 0usize;

    paths
        .iter()
        .map(|path| {
            let mut track = read_track(path);

            match track.artwork.as_ref().map(String::len) {
                Some(cost) if spent + cost <= MAX_ARTWORK_TOTAL => spent += cost,
                // Dropped rather than truncated: half an image is not an
                // image, and a broken one looks like a bug rather than a cap.
                Some(_) => track.artwork = None,
                None => {}
            }

            track
        })
        .collect()
}

pub fn read_track(path: &Path) -> Track {
    let mut track = Track {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        ..Track::default()
    };

    if let Ok(meta) = std::fs::metadata(path) {
        track.size = meta.len();
        track.modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_secs());
    }

    // Only the head of the file: tags live at the front, and reading a 40 MB
    // FLAC to find a title would make the dialog crawl.
    let Ok(blob) = read_head(path) else {
        return track;
    };

    match extension(path).as_str() {
        "mp3" => read_id3(&blob, &mut track),
        "m4a" | "m4p" | "mp4" => read_mp4(&blob, &mut track),
        // Others still list, by filename.
        _ => {}
    }

    track
}

fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut blob = Vec::new();
    file.by_ref().take(HEAD_BYTES as u64).read_to_end(&mut blob)?;

    Ok(blob)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_known_answers() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn synchsafe_sizes_drop_the_top_bit_of_each_byte() {
        // 0x7F 0x7F is 16383, not 32639.
        assert_eq!(synchsafe(&[0, 0, 0x7F, 0x7F]), 16383);
        assert_eq!(synchsafe(&[0, 0, 0x02, 0x01]), 257);
    }

    #[test]
    fn text_frames_decode_each_encoding() {
        // Latin-1.
        assert_eq!(id3_text(b"\x00Hello").as_deref(), Some("Hello"));
        // UTF-8.
        assert_eq!(id3_text(b"\x03Hi").as_deref(), Some("Hi"));
        // UTF-16LE with a mark.
        let utf16 = [1u8, 0xFF, 0xFE, b'H', 0, b'i', 0];
        assert_eq!(id3_text(&utf16).as_deref(), Some("Hi"));
        // Trailing nulls are not part of the value.
        assert_eq!(id3_text(b"\x00Song\0\0").as_deref(), Some("Song"));
        assert!(id3_text(b"\x00").is_none());
    }

    #[test]
    fn an_id3_tag_yields_its_title_and_artist() {
        let mut blob = Vec::new();
        blob.extend_from_slice(b"ID3\x03\x00\x00");
        // Tag size, synchsafe: two frames of 10 + 6 bytes each.
        blob.extend_from_slice(&[0, 0, 0, 32]);
        for (id, text) in [(b"TIT2", "Song"), (b"TPE1", "Band")] {
            blob.extend_from_slice(id);
            blob.extend_from_slice(&[0, 0, 0, (text.len() + 1) as u8]);
            blob.extend_from_slice(&[0, 0]);
            blob.push(0);
            blob.extend_from_slice(text.as_bytes());
        }

        let mut track = Track::default();
        read_id3(&blob, &mut track);

        assert_eq!(track.title.as_deref(), Some("Song"));
        assert_eq!(track.artist.as_deref(), Some("Band"));
    }

    #[test]
    fn a_file_that_is_not_a_tag_is_left_alone_rather_than_crashing() {
        let mut track = Track::default();
        read_id3(b"not an id3 tag at all", &mut track);
        read_id3(b"ID3", &mut track);
        read_mp4(b"\x00\x00\x00\x04", &mut track);

        assert!(track.title.is_none());
    }

    #[test]
    fn oversized_artwork_is_dropped_rather_than_sent() {
        let huge = vec![0u8; MAX_ARTWORK_BYTES + 1];
        assert!(data_uri("image/jpeg", &huge).is_none());
        assert!(data_uri("image/jpeg", &[]).is_none());
        assert!(data_uri("", b"xyz").unwrap().starts_with("data:image/jpeg;"));
    }
}

#[cfg(test)]
mod live {
    /// Reads whatever is in a real Spotify local-files folder. Ignored by
    /// default; a diagnostic, not a test.
    #[ignore]
    #[test]
    fn live_tracks() {
        let folder = std::path::PathBuf::from(
            std::env::var("INFERNO_TRACK_DIR").unwrap_or_default(),
        );
        let Ok(entries) = std::fs::read_dir(&folder) else {
            println!("no such folder");
            return;
        };

        for entry in entries.filter_map(Result::ok) {
            let track = super::read_track(&entry.path());
            println!(
                "{} | title={:?} artist={:?} album={:?} art={} bytes",
                track.file_name,
                track.title,
                track.artist,
                track.album,
                track.artwork.as_ref().map(|a| a.len()).unwrap_or(0)
            );
        }
    }
}
