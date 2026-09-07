//! Thin `#[tauri::command]` wrappers around [`SoundpadRemoteControl`].
//!
//! Every method on the client gets a matching command here, one-to-one, so
//! the frontend test harness can exercise each case individually. State is a
//! single shared `Mutex<SoundpadRemoteControl>` — Soundpad's pipe protocol is
//! request/response over one handle, so calls are serialized anyway.

use std::sync::Mutex;

use tauri::State;

use super::error::SoundpadResult;
use super::remote_control::{PlayStatus, SoundpadRemoteControl};

pub type SoundpadState = Mutex<SoundpadRemoteControl>;

#[tauri::command]
pub fn soundpad_play_sound(
    state: State<SoundpadState>,
    index: i32,
    speakers: bool,
    mic: bool,
) -> bool {
    state.lock().unwrap().play_sound(index, speakers, mic)
}

#[tauri::command]
pub fn soundpad_play_sound_from_category(
    state: State<SoundpadState>,
    category_index: i32,
    sound_index: i32,
    speakers: bool,
    mic: bool,
) -> bool {
    state
        .lock()
        .unwrap()
        .play_sound_from_category(category_index, sound_index, speakers, mic)
}

#[tauri::command]
pub fn soundpad_play_previous_sound(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().play_previous_sound()
}

#[tauri::command]
pub fn soundpad_play_next_sound(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().play_next_sound()
}

#[tauri::command]
pub fn soundpad_stop_sound(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().stop_sound()
}

#[tauri::command]
pub fn soundpad_toggle_pause(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().toggle_pause()
}

#[tauri::command]
pub fn soundpad_jump_ms(state: State<SoundpadState>, time_millis: i64) -> bool {
    state.lock().unwrap().jump_ms(time_millis)
}

#[tauri::command]
pub fn soundpad_seek_ms(state: State<SoundpadState>, time_millis: i64) -> bool {
    state.lock().unwrap().seek_ms(time_millis)
}

#[tauri::command]
pub fn soundpad_play_random_sound(state: State<SoundpadState>, speakers: bool, mic: bool) -> bool {
    state.lock().unwrap().play_random_sound(speakers, mic)
}

#[tauri::command]
pub fn soundpad_play_random_sound_from_category(
    state: State<SoundpadState>,
    category_index: i32,
    speakers: bool,
    mic: bool,
) -> bool {
    state
        .lock()
        .unwrap()
        .play_random_sound_from_category(category_index, speakers, mic)
}

#[tauri::command]
pub fn soundpad_play_selected_sound(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().play_selected_sound()
}

#[tauri::command]
pub fn soundpad_play_current_sound_again(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().play_current_sound_again()
}

#[tauri::command]
pub fn soundpad_play_previously_played_sound(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().play_previously_played_sound()
}

#[tauri::command]
pub fn soundpad_add_sound(
    state: State<SoundpadState>,
    path: String,
    category_index: Option<i32>,
    index: Option<i32>,
) -> String {
    state
        .lock()
        .unwrap()
        .add_sound(&path, category_index, index)
}

#[tauri::command]
pub fn soundpad_remove_selected_entries(
    state: State<SoundpadState>,
    remove_from_disk: bool,
) -> bool {
    state.lock().unwrap().remove_selected_entries(remove_from_disk)
}

#[tauri::command]
pub fn soundpad_get_sound_file_count(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_sound_file_count()
}

#[tauri::command]
pub fn soundpad_search(state: State<SoundpadState>, search_term: String) -> bool {
    state.lock().unwrap().search(&search_term)
}

#[tauri::command]
pub fn soundpad_reset_search(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().reset_search()
}

#[tauri::command]
pub fn soundpad_select_previous_hit(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().select_previous_hit()
}

#[tauri::command]
pub fn soundpad_select_next_hit(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().select_next_hit()
}

#[tauri::command]
pub fn soundpad_select_row(state: State<SoundpadState>, index: i32) -> bool {
    state.lock().unwrap().select_row(index)
}

#[tauri::command]
pub fn soundpad_scroll_by(state: State<SoundpadState>, index: i32) -> bool {
    state.lock().unwrap().scroll_by(index)
}

#[tauri::command]
pub fn soundpad_scroll_to(state: State<SoundpadState>, index: i32) -> bool {
    state.lock().unwrap().scroll_to(index)
}

#[tauri::command]
pub fn soundpad_undo(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().undo()
}

#[tauri::command]
pub fn soundpad_redo(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().redo()
}

#[tauri::command]
pub fn soundpad_add_category(
    state: State<SoundpadState>,
    name: String,
    parent_category_index: i32,
) -> bool {
    state
        .lock()
        .unwrap()
        .add_category(&name, parent_category_index)
}

#[tauri::command]
pub fn soundpad_select_category(state: State<SoundpadState>, index: i32) -> bool {
    state.lock().unwrap().select_category(index)
}

#[tauri::command]
pub fn soundpad_select_previous_category(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().select_previous_category()
}

#[tauri::command]
pub fn soundpad_select_next_category(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().select_next_category()
}

#[tauri::command]
pub fn soundpad_remove_category(state: State<SoundpadState>, category_index: i32) -> bool {
    state.lock().unwrap().remove_category(category_index)
}

#[tauri::command]
pub fn soundpad_get_volume(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_volume()
}

#[tauri::command]
pub fn soundpad_is_muted(state: State<SoundpadState>) -> SoundpadResult<bool> {
    state.lock().unwrap().is_muted()
}

#[tauri::command]
pub fn soundpad_toggle_mute(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().toggle_mute()
}

#[tauri::command]
pub fn soundpad_get_play_status(state: State<SoundpadState>) -> PlayStatus {
    state.lock().unwrap().get_play_status()
}

#[tauri::command]
pub fn soundpad_get_playback_position(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_playback_position()
}

#[tauri::command]
pub fn soundpad_get_playback_duration(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_playback_duration()
}

#[tauri::command]
pub fn soundpad_get_sound_list(
    state: State<SoundpadState>,
    from_index: Option<i32>,
    to_index: Option<i32>,
) -> SoundpadResult<String> {
    state.lock().unwrap().get_sound_list(from_index, to_index)
}

#[tauri::command]
pub fn soundpad_get_main_frame_title_text(state: State<SoundpadState>) -> SoundpadResult<String> {
    state.lock().unwrap().get_main_frame_title_text()
}

#[tauri::command]
pub fn soundpad_get_status_bar_text(state: State<SoundpadState>) -> SoundpadResult<String> {
    state.lock().unwrap().get_status_bar_text()
}

#[tauri::command]
pub fn soundpad_get_version(state: State<SoundpadState>) -> SoundpadResult<String> {
    state.lock().unwrap().get_version()
}

#[tauri::command]
pub fn soundpad_get_remote_control_version(
    state: State<SoundpadState>,
) -> SoundpadResult<String> {
    state.lock().unwrap().get_remote_control_version()
}

#[tauri::command]
pub fn soundpad_is_compatible(state: State<SoundpadState>) -> SoundpadResult<bool> {
    state.lock().unwrap().is_compatible()
}

#[tauri::command]
pub fn soundpad_is_alive(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().is_alive()
}

#[tauri::command]
pub fn soundpad_is_trial(state: State<SoundpadState>) -> SoundpadResult<bool> {
    state.lock().unwrap().is_trial()
}

#[tauri::command]
pub fn soundpad_start_recording(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().start_recording()
}

#[tauri::command]
pub fn soundpad_stop_recording(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().stop_recording()
}

#[tauri::command]
pub fn soundpad_start_recording_speakers(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().start_recording_speakers()
}

#[tauri::command]
pub fn soundpad_start_recording_microphone(state: State<SoundpadState>) -> bool {
    state.lock().unwrap().start_recording_microphone()
}

#[tauri::command]
pub fn soundpad_get_recording_position(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_recording_position()
}

#[tauri::command]
pub fn soundpad_get_recording_peak(state: State<SoundpadState>) -> SoundpadResult<i64> {
    state.lock().unwrap().get_recording_peak()
}
