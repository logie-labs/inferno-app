//! Rust port of `soundpad_control`'s `SoundpadRemoteControl`
//! (<https://github.com/Ilya-Kokhanovsky/soundpad.py>, MIT licensed).
//!
//! Soundpad exposes a remote-control API over a Windows named pipe
//! (`\\.\pipe\sp_remote_control`): a request is a plain-text command like
//! `DoPlaySound(0,False,True)`, and the response is either `R-200` (success),
//! an `R-`-prefixed error, or raw data for `Get*` requests. This client
//! mirrors the upstream Python wrapper's behavior method-for-method,
//! including which calls swallow errors (returning `false`/an empty value)
//! versus which propagate a [`SoundpadError`].

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::error::{SoundpadError, SoundpadResult};

/// Playback state as reported by `GetPlayStatus()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlayStatus {
    Stopped,
    Playing,
    Paused,
    Seeking,
}

/// Remote controller for the Soundpad application through a named pipe.
///
/// Not thread-safe on its own (the pipe handle is exclusive-access); wrap it
/// in a `Mutex` when sharing across Tauri command invocations.
#[derive(Debug)]
pub struct SoundpadRemoteControl {
    pipe: Option<File>,
    pipe_name: String,
    chunk_size: usize,
    last_request_timestamp: u128,
}

impl Default for SoundpadRemoteControl {
    fn default() -> Self {
        Self::new()
    }
}

impl SoundpadRemoteControl {
    /// Remote-control protocol version this client speaks, used by [`Self::is_compatible`].
    pub const CLIENT_VERSION: &'static str = "1.1.2";

    pub fn new() -> Self {
        Self {
            pipe: None,
            pipe_name: "sp_remote_control".to_string(),
            chunk_size: 1024,
            last_request_timestamp: Self::current_millis(),
        }
    }

    fn current_millis() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }

    /// Renders a bool the way Soundpad's request parser expects it (`True`/`False`).
    fn py_bool(value: bool) -> &'static str {
        if value {
            "True"
        } else {
            "False"
        }
    }

    fn join_params(parts: impl IntoIterator<Item = Option<String>>) -> String {
        parts.into_iter().flatten().collect::<Vec<_>>().join(",")
    }

    fn init_connection(&mut self) -> SoundpadResult<()> {
        if self.pipe.is_none() {
            let path = format!(r"\\.\pipe\{}", self.pipe_name);
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => self.pipe = Some(file),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return Err(SoundpadError::NotLaunched);
                }
                Err(err) => return Err(err.into()),
            }
        }
        Ok(())
    }

    fn close_connection(&mut self) {
        // Dropping the handle closes it; like upstream, close errors are ignored.
        self.pipe = None;
    }

    fn is_empty(response: &str) -> bool {
        response.is_empty()
    }

    fn is_success(response: &str) -> bool {
        response.starts_with("R-200")
    }

    // The `parse_*` functions below are the pure interpretation half of
    // Soundpad's response protocol (given a response string, decide
    // success/error/value). They're split out from the `handle_*_get_request`
    // methods - which also have to own a live pipe - purely so they can be
    // unit tested without a running Soundpad instance.

    fn parse_string_get_response(response: String) -> SoundpadResult<String> {
        if response.starts_with('R') {
            Err(SoundpadError::Request { response })
        } else if Self::is_empty(&response) {
            Err(SoundpadError::NotLaunched)
        } else {
            Ok(response)
        }
    }

    fn parse_empty_get_response(response: String) -> SoundpadResult<String> {
        if Self::is_empty(&response) {
            Err(SoundpadError::NotLaunched)
        } else {
            Ok(response)
        }
    }

    fn parse_simple_get_response(response: String) -> SoundpadResult<String> {
        if response.starts_with('R') {
            Err(SoundpadError::Request { response })
        } else {
            Ok(response)
        }
    }

    fn parse_numeric_long_response(response: String) -> SoundpadResult<i64> {
        if response.starts_with('R') {
            Err(SoundpadError::Request { response })
        } else if Self::is_empty(&response) {
            Err(SoundpadError::NotLaunched)
        } else {
            Ok(response.parse::<i64>().unwrap_or(-1))
        }
    }

    fn parse_play_status(response: &str) -> PlayStatus {
        match response {
            "PAUSED" => PlayStatus::Paused,
            "STOPPED" => PlayStatus::Stopped,
            "PLAYING" => PlayStatus::Playing,
            "SEEKING" => PlayStatus::Seeking,
            _ => PlayStatus::Stopped,
        }
    }

    fn handle_string_get_request(&mut self, request: &str) -> SoundpadResult<String> {
        let response = self.send_request_no_exception(request);
        Self::parse_string_get_response(response)
    }

    fn handle_empty_get_request(&mut self, request: &str) -> SoundpadResult<String> {
        let response = self.send_request_no_exception(request);
        Self::parse_empty_get_response(response)
    }

    fn handle_simple_get_request(&mut self, request: &str) -> SoundpadResult<String> {
        let response = self.send_request_no_exception(request);
        Self::parse_simple_get_response(response)
    }

    fn handle_numeric_long_get_request(&mut self, request: &str) -> SoundpadResult<i64> {
        let response = self.send_request_no_exception(request);
        Self::parse_numeric_long_response(response)
    }

    fn send_request(&mut self, request: &[u8]) -> SoundpadResult<String> {
        self.init_connection()?;

        let now_ms = Self::current_millis();
        if now_ms == self.last_request_timestamp {
            std::thread::sleep(Duration::from_millis(1));
        }

        let pipe = self
            .pipe
            .as_mut()
            .expect("init_connection ensures the pipe is set");

        pipe.write_all(request)?;
        pipe.seek(SeekFrom::Start(0))?;

        let mut buffer = vec![0u8; self.chunk_size];
        let bytes_read = pipe.read(&mut buffer)?;
        pipe.seek(SeekFrom::Start(0))?;

        Ok(String::from_utf8_lossy(&buffer[..bytes_read]).into_owned())
    }

    /// Sends a request, swallowing any connection error into an empty response
    /// (matching upstream's `_send_request_no_exception`).
    fn send_request_no_exception(&mut self, request: &str) -> String {
        match self.send_request(request.as_bytes()) {
            Ok(response) => response,
            Err(_) => {
                self.close_connection();
                String::new()
            }
        }
    }

    // ---- Playback control ----------------------------------------------

    pub fn play_sound(&mut self, index: i32, speakers: bool, mic: bool) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoPlaySound({},{},{})",
            index,
            Self::py_bool(speakers),
            Self::py_bool(mic)
        )))
    }

    pub fn play_sound_from_category(
        &mut self,
        category_index: i32,
        sound_index: i32,
        speakers: bool,
        mic: bool,
    ) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoPlaySoundFromCategory({},{},{},{})",
            category_index,
            sound_index,
            Self::py_bool(speakers),
            Self::py_bool(mic)
        )))
    }

    pub fn play_previous_sound(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoPlayPreviousSound()"))
    }

    pub fn play_next_sound(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoPlayNextSound()"))
    }

    pub fn stop_sound(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoStopSound()"))
    }

    pub fn toggle_pause(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoTogglePause()"))
    }

    /// Jumps relative to the current playback position, positive or negative.
    pub fn jump_ms(&mut self, time_millis: i64) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoJumpMs({time_millis})")))
    }

    /// Seeks to an absolute position from the start of the sound.
    pub fn seek_ms(&mut self, time_millis: i64) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoSeekMs({time_millis})")))
    }

    pub fn play_random_sound(&mut self, speakers: bool, mic: bool) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoPlayRandomSound({},{})",
            Self::py_bool(speakers),
            Self::py_bool(mic)
        )))
    }

    pub fn play_random_sound_from_category(
        &mut self,
        category_index: i32,
        speakers: bool,
        mic: bool,
    ) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoPlayRandomSoundFromCategory({},{},{})",
            category_index,
            Self::py_bool(speakers),
            Self::py_bool(mic)
        )))
    }

    pub fn play_selected_sound(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoPlaySelectedSound()"))
    }

    pub fn play_current_sound_again(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoPlayCurrentSoundAgain()"))
    }

    pub fn play_previously_played_sound(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoPlayPreviouslyPlayedSound()"))
    }

    // ---- Library management ---------------------------------------------

    /// Adds a sound file to the Soundpad library.
    ///
    /// Note: upstream doesn't check the response for success here (unlike its
    /// other `Do*` wrappers), so this returns the raw pipe response as-is.
    pub fn add_sound(
        &mut self,
        path: &str,
        category_index: Option<i32>,
        index: Option<i32>,
    ) -> String {
        let joined = Self::join_params([
            Some(path.to_string()),
            category_index.map(|v| v.to_string()),
            index.map(|v| v.to_string()),
        ]);
        self.send_request_no_exception(&format!("DoAddSound({joined})"))
    }

    pub fn remove_selected_entries(&mut self, remove_from_disk: bool) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoRemoveSelectedEntries({})",
            Self::py_bool(remove_from_disk)
        )))
    }

    pub fn get_sound_file_count(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetSoundFileCount()")
    }

    pub fn search(&mut self, search_term: &str) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoSearch({search_term})")))
    }

    pub fn reset_search(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoResetSearch()"))
    }

    pub fn select_previous_hit(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoSelectPreviousHit()"))
    }

    pub fn select_next_hit(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoSelectNextHit()"))
    }

    pub fn select_row(&mut self, index: i32) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoSelectIndex({index})")))
    }

    pub fn scroll_by(&mut self, index: i32) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoScrollBy({index})")))
    }

    pub fn scroll_to(&mut self, index: i32) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoScrollTo({index})")))
    }

    pub fn undo(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoUndo()"))
    }

    pub fn redo(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoRedo()"))
    }

    // ---- Categories -------------------------------------------------------

    pub fn add_category(&mut self, name: &str, parent_category_index: i32) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!(
            "DoAddCategory({name}, {parent_category_index})"
        )))
    }

    pub fn select_category(&mut self, index: i32) -> bool {
        Self::is_success(&self.send_request_no_exception(&format!("DoSelectCategory({index})")))
    }

    pub fn select_previous_category(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoSelectPreviousCategory()"))
    }

    pub fn select_next_category(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoSelectNextCategory()"))
    }

    pub fn remove_category(&mut self, category_index: i32) -> bool {
        Self::is_success(
            &self.send_request_no_exception(&format!("DoRemoveCategory({category_index})")),
        )
    }

    // ---- Volume / mute ------------------------------------------------

    pub fn get_volume(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetVolume()")
    }

    pub fn is_muted(&mut self) -> SoundpadResult<bool> {
        Ok(self.handle_numeric_long_get_request("IsMuted()")? != 0)
    }

    pub fn toggle_mute(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoToggleMute()"))
    }

    // ---- Status & information ----------------------------------------

    pub fn get_play_status(&mut self) -> PlayStatus {
        let response = self.send_request_no_exception("GetPlayStatus()");
        Self::parse_play_status(&response)
    }

    pub fn get_playback_position(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetPlaybackPositionInMs()")
    }

    pub fn get_playback_duration(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetPlaybackDurationInMs()")
    }

    pub fn get_sound_list(
        &mut self,
        from_index: Option<i32>,
        to_index: Option<i32>,
    ) -> SoundpadResult<String> {
        let joined = Self::join_params([
            from_index.map(|v| v.to_string()),
            to_index.map(|v| v.to_string()),
        ]);
        self.handle_string_get_request(&format!("GetSoundlist({joined})"))
    }

    pub fn get_main_frame_title_text(&mut self) -> SoundpadResult<String> {
        self.handle_simple_get_request("GetTitleText()")
    }

    pub fn get_status_bar_text(&mut self) -> SoundpadResult<String> {
        self.handle_simple_get_request("GetStatusBarText()")
    }

    pub fn get_version(&mut self) -> SoundpadResult<String> {
        self.handle_empty_get_request("GetVersion()")
    }

    pub fn get_remote_control_version(&mut self) -> SoundpadResult<String> {
        self.handle_empty_get_request("GetRemoteControlVersion()")
    }

    pub fn is_compatible(&mut self) -> SoundpadResult<bool> {
        Ok(Self::CLIENT_VERSION == self.get_remote_control_version()?)
    }

    pub fn is_alive(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("IsAlive()"))
    }

    pub fn is_trial(&mut self) -> SoundpadResult<bool> {
        Ok(self.handle_numeric_long_get_request("IsTrial()")? != 0)
    }

    // ---- Recording ------------------------------------------------------

    pub fn start_recording(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoStartRecording()"))
    }

    pub fn stop_recording(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoStopRecording()"))
    }

    pub fn start_recording_speakers(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoStartRecordingSpeakers()"))
    }

    pub fn start_recording_microphone(&mut self) -> bool {
        Self::is_success(&self.send_request_no_exception("DoStartRecordingMicrophone()"))
    }

    pub fn get_recording_position(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetRecordingPositionInMs()")
    }

    pub fn get_recording_peak(&mut self) -> SoundpadResult<i64> {
        self.handle_numeric_long_get_request("GetRecordingPeak()")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_success / is_empty ----------------------------------------

    #[test]
    fn is_success_accepts_r_200_and_anything_prefixed_by_it() {
        assert!(SoundpadRemoteControl::is_success("R-200"));
        assert!(SoundpadRemoteControl::is_success("R-200,extra-data"));
    }

    #[test]
    fn is_success_rejects_other_codes_and_data_responses() {
        assert!(!SoundpadRemoteControl::is_success("R-404"));
        assert!(!SoundpadRemoteControl::is_success(""));
        assert!(!SoundpadRemoteControl::is_success("PLAYING"));
    }

    #[test]
    fn is_empty_matches_only_the_empty_string() {
        assert!(SoundpadRemoteControl::is_empty(""));
        assert!(!SoundpadRemoteControl::is_empty("x"));
    }

    // ---- py_bool / join_params ------------------------------------------

    #[test]
    fn py_bool_uses_python_capitalization() {
        assert_eq!(SoundpadRemoteControl::py_bool(true), "True");
        assert_eq!(SoundpadRemoteControl::py_bool(false), "False");
    }

    #[test]
    fn join_params_drops_none_and_joins_the_rest_with_commas() {
        assert_eq!(
            SoundpadRemoteControl::join_params([None, None::<String>]),
            ""
        );
        assert_eq!(
            SoundpadRemoteControl::join_params([Some("a".to_string()), None]),
            "a"
        );
        assert_eq!(
            SoundpadRemoteControl::join_params([
                Some("path".to_string()),
                Some("2".to_string()),
                Some("5".to_string())
            ]),
            "path,2,5"
        );
    }

    // ---- parse_play_status ------------------------------------------------

    #[test]
    fn parse_play_status_maps_every_known_state() {
        assert_eq!(
            SoundpadRemoteControl::parse_play_status("PAUSED"),
            PlayStatus::Paused
        );
        assert_eq!(
            SoundpadRemoteControl::parse_play_status("STOPPED"),
            PlayStatus::Stopped
        );
        assert_eq!(
            SoundpadRemoteControl::parse_play_status("PLAYING"),
            PlayStatus::Playing
        );
        assert_eq!(
            SoundpadRemoteControl::parse_play_status("SEEKING"),
            PlayStatus::Seeking
        );
    }

    #[test]
    fn parse_play_status_defaults_unknown_and_empty_responses_to_stopped() {
        assert_eq!(
            SoundpadRemoteControl::parse_play_status(""),
            PlayStatus::Stopped
        );
        assert_eq!(
            SoundpadRemoteControl::parse_play_status("GARBAGE"),
            PlayStatus::Stopped
        );
    }

    // ---- parse_numeric_long_response --------------------------------------

    #[test]
    fn parse_numeric_long_response_parses_valid_integers() {
        assert_eq!(
            SoundpadRemoteControl::parse_numeric_long_response("42".to_string()),
            Ok(42)
        );
        assert_eq!(
            SoundpadRemoteControl::parse_numeric_long_response("-1".to_string()),
            Ok(-1)
        );
    }

    #[test]
    fn parse_numeric_long_response_falls_back_to_negative_one_on_unparseable_text() {
        // Mirrors upstream's `except ValueError: return -1`.
        assert_eq!(
            SoundpadRemoteControl::parse_numeric_long_response("not-a-number".to_string()),
            Ok(-1)
        );
    }

    #[test]
    fn parse_numeric_long_response_maps_empty_to_not_launched() {
        assert_eq!(
            SoundpadRemoteControl::parse_numeric_long_response("".to_string()),
            Err(SoundpadError::NotLaunched)
        );
    }

    #[test]
    fn parse_numeric_long_response_maps_r_prefixed_response_to_request_error() {
        assert_eq!(
            SoundpadRemoteControl::parse_numeric_long_response("R-404".to_string()),
            Err(SoundpadError::Request {
                response: "R-404".to_string()
            })
        );
    }

    // ---- parse_string_get_response (GetSoundlist) -------------------------

    #[test]
    fn parse_string_get_response_returns_data_responses() {
        assert_eq!(
            SoundpadRemoteControl::parse_string_get_response("0;My Sound;1000".to_string()),
            Ok("0;My Sound;1000".to_string())
        );
    }

    #[test]
    fn parse_string_get_response_maps_empty_to_not_launched() {
        assert_eq!(
            SoundpadRemoteControl::parse_string_get_response("".to_string()),
            Err(SoundpadError::NotLaunched)
        );
    }

    #[test]
    fn parse_string_get_response_maps_r_prefixed_response_to_request_error() {
        assert_eq!(
            SoundpadRemoteControl::parse_string_get_response("R-404".to_string()),
            Err(SoundpadError::Request {
                response: "R-404".to_string()
            })
        );
    }

    // ---- parse_empty_get_response (GetVersion / GetRemoteControlVersion) --

    #[test]
    fn parse_empty_get_response_maps_empty_to_not_launched() {
        assert_eq!(
            SoundpadRemoteControl::parse_empty_get_response("".to_string()),
            Err(SoundpadError::NotLaunched)
        );
    }

    #[test]
    fn parse_empty_get_response_returns_any_non_empty_response_unchecked() {
        assert_eq!(
            SoundpadRemoteControl::parse_empty_get_response("1.11.2".to_string()),
            Ok("1.11.2".to_string())
        );
        // Unlike the other three handlers, this one does NOT treat a
        // `R`-prefixed response as an error - it only checks emptiness,
        // matching upstream's `_handle_empty_get_request`.
        assert_eq!(
            SoundpadRemoteControl::parse_empty_get_response("R-404".to_string()),
            Ok("R-404".to_string())
        );
    }

    // ---- parse_simple_get_response (GetTitleText / GetStatusBarText) ------

    #[test]
    fn parse_simple_get_response_returns_data_responses() {
        assert_eq!(
            SoundpadRemoteControl::parse_simple_get_response("Soundpad".to_string()),
            Ok("Soundpad".to_string())
        );
    }

    #[test]
    fn parse_simple_get_response_does_not_treat_empty_as_an_error() {
        // Unlike the other three handlers, this one has no emptiness check at
        // all, matching upstream's `_handle_simple_get_request`.
        assert_eq!(
            SoundpadRemoteControl::parse_simple_get_response("".to_string()),
            Ok("".to_string())
        );
    }

    #[test]
    fn parse_simple_get_response_maps_r_prefixed_response_to_request_error() {
        assert_eq!(
            SoundpadRemoteControl::parse_simple_get_response("R-404".to_string()),
            Err(SoundpadError::Request {
                response: "R-404".to_string()
            })
        );
    }

    // ---- construction -------------------------------------------------

    #[test]
    fn new_starts_with_no_open_pipe() {
        let client = SoundpadRemoteControl::new();
        assert!(client.pipe.is_none());
    }
}
