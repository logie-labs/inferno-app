import { invoke } from "@tauri-apps/api/core"

/**
 * Mirrors `SoundpadError` in `src-tauri/src/addons/soundpad/error.rs`.
 * Internally-tagged on `kind`, so each variant's extra fields sit alongside
 * it rather than nested - keep this in sync with that enum's `#[serde(...)]`.
 */
export type SoundpadError =
  | { kind: "NotLaunched" }
  | { kind: "Request"; response: string }
  | { kind: "Io"; message: string }

export function soundpadErrorMessage(error: SoundpadError): string {
  switch (error.kind) {
    case "NotLaunched":
      return "Soundpad is not launched or the pipe does not exist."
    case "Request":
      return `Soundpad rejected the request. (Response: ${error.response})`
    case "Io":
      return `Failed to communicate with Soundpad: ${error.message}`
  }
}

/** Mirrors `PlayStatus` in `remote_control.rs` (`SCREAMING_SNAKE_CASE` on the wire). */
export type PlayStatus = "STOPPED" | "PLAYING" | "PAUSED" | "SEEKING"

/**
 * Thin typed wrappers around the `soundpad_*` Tauri commands - one per
 * method on the Rust `SoundpadRemoteControl`. Fallible calls (the `Get*`
 * style requests) reject with a {@link SoundpadError}; the rest resolve to
 * `false`/an empty value on failure instead of throwing, matching the Rust
 * client's own error-swallowing behavior.
 */
export const soundpad = {
  // ---- Playback control -------------------------------------------------
  playSound: (index: number, speakers: boolean, mic: boolean) =>
    invoke<boolean>("soundpad_play_sound", { index, speakers, mic }),
  playSoundFromCategory: (
    categoryIndex: number,
    soundIndex: number,
    speakers: boolean,
    mic: boolean
  ) =>
    invoke<boolean>("soundpad_play_sound_from_category", {
      categoryIndex,
      soundIndex,
      speakers,
      mic,
    }),
  playPreviousSound: () => invoke<boolean>("soundpad_play_previous_sound"),
  playNextSound: () => invoke<boolean>("soundpad_play_next_sound"),
  stopSound: () => invoke<boolean>("soundpad_stop_sound"),
  togglePause: () => invoke<boolean>("soundpad_toggle_pause"),
  jumpMs: (timeMillis: number) =>
    invoke<boolean>("soundpad_jump_ms", { timeMillis }),
  seekMs: (timeMillis: number) =>
    invoke<boolean>("soundpad_seek_ms", { timeMillis }),
  playRandomSound: (speakers: boolean, mic: boolean) =>
    invoke<boolean>("soundpad_play_random_sound", { speakers, mic }),
  playRandomSoundFromCategory: (
    categoryIndex: number,
    speakers: boolean,
    mic: boolean
  ) =>
    invoke<boolean>("soundpad_play_random_sound_from_category", {
      categoryIndex,
      speakers,
      mic,
    }),
  playSelectedSound: () => invoke<boolean>("soundpad_play_selected_sound"),
  playCurrentSoundAgain: () =>
    invoke<boolean>("soundpad_play_current_sound_again"),
  playPreviouslyPlayedSound: () =>
    invoke<boolean>("soundpad_play_previously_played_sound"),

  // ---- Library management -------------------------------------------
  addSound: (path: string, categoryIndex?: number, index?: number) =>
    invoke<string>("soundpad_add_sound", { path, categoryIndex, index }),
  removeSelectedEntries: (removeFromDisk: boolean) =>
    invoke<boolean>("soundpad_remove_selected_entries", { removeFromDisk }),
  getSoundFileCount: () => invoke<number>("soundpad_get_sound_file_count"),
  search: (searchTerm: string) =>
    invoke<boolean>("soundpad_search", { searchTerm }),
  resetSearch: () => invoke<boolean>("soundpad_reset_search"),
  selectPreviousHit: () => invoke<boolean>("soundpad_select_previous_hit"),
  selectNextHit: () => invoke<boolean>("soundpad_select_next_hit"),
  selectRow: (index: number) =>
    invoke<boolean>("soundpad_select_row", { index }),
  scrollBy: (index: number) => invoke<boolean>("soundpad_scroll_by", { index }),
  scrollTo: (index: number) => invoke<boolean>("soundpad_scroll_to", { index }),
  undo: () => invoke<boolean>("soundpad_undo"),
  redo: () => invoke<boolean>("soundpad_redo"),

  // ---- Categories -----------------------------------------------------
  addCategory: (name: string, parentCategoryIndex: number) =>
    invoke<boolean>("soundpad_add_category", { name, parentCategoryIndex }),
  selectCategory: (index: number) =>
    invoke<boolean>("soundpad_select_category", { index }),
  selectPreviousCategory: () =>
    invoke<boolean>("soundpad_select_previous_category"),
  selectNextCategory: () => invoke<boolean>("soundpad_select_next_category"),
  removeCategory: (categoryIndex: number) =>
    invoke<boolean>("soundpad_remove_category", { categoryIndex }),

  // ---- Volume / mute --------------------------------------------------
  getVolume: () => invoke<number>("soundpad_get_volume"),
  isMuted: () => invoke<boolean>("soundpad_is_muted"),
  toggleMute: () => invoke<boolean>("soundpad_toggle_mute"),

  // ---- Status & information -------------------------------------------
  getPlayStatus: () => invoke<PlayStatus>("soundpad_get_play_status"),
  getPlaybackPosition: () => invoke<number>("soundpad_get_playback_position"),
  getPlaybackDuration: () => invoke<number>("soundpad_get_playback_duration"),
  getSoundList: (fromIndex?: number, toIndex?: number) =>
    invoke<string>("soundpad_get_sound_list", { fromIndex, toIndex }),
  getMainFrameTitleText: () =>
    invoke<string>("soundpad_get_main_frame_title_text"),
  getStatusBarText: () => invoke<string>("soundpad_get_status_bar_text"),
  getVersion: () => invoke<string>("soundpad_get_version"),
  getRemoteControlVersion: () =>
    invoke<string>("soundpad_get_remote_control_version"),
  isCompatible: () => invoke<boolean>("soundpad_is_compatible"),
  isAlive: () => invoke<boolean>("soundpad_is_alive"),
  isTrial: () => invoke<boolean>("soundpad_is_trial"),

  // ---- Recording --------------------------------------------------------
  startRecording: () => invoke<boolean>("soundpad_start_recording"),
  stopRecording: () => invoke<boolean>("soundpad_stop_recording"),
  startRecordingSpeakers: () =>
    invoke<boolean>("soundpad_start_recording_speakers"),
  startRecordingMicrophone: () =>
    invoke<boolean>("soundpad_start_recording_microphone"),
  getRecordingPosition: () => invoke<number>("soundpad_get_recording_position"),
  getRecordingPeak: () => invoke<number>("soundpad_get_recording_peak"),
}
