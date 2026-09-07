import { soundpad } from "@/lib/soundpad"

export type FieldSpec =
  | { name: string; label: string; type: "number"; defaultValue: number }
  | { name: string; label: string; type: "optionalNumber"; defaultValue: string }
  | { name: string; label: string; type: "boolean"; defaultValue: boolean }
  | { name: string; label: string; type: "text"; defaultValue: string }

export type FieldValues = Record<string, number | boolean | string | undefined>

export type TestCase = {
  id: string
  label: string
  group: string
  /** Read-only and side-effect-free: safe to include in "run all". */
  autoRun: boolean
  fields?: FieldSpec[]
  run: (values: FieldValues) => Promise<unknown>
}

function num(values: FieldValues, name: string): number {
  return Number(values[name])
}

function optNum(values: FieldValues, name: string): number | undefined {
  const raw = values[name]
  if (raw === undefined || raw === "") return undefined
  const parsed = Number(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

function bool(values: FieldValues, name: string): boolean {
  return Boolean(values[name])
}

function text(values: FieldValues, name: string): string {
  return String(values[name] ?? "")
}

const speakersField: FieldSpec = {
  name: "speakers",
  label: "speakers",
  type: "boolean",
  defaultValue: false,
}
const micField: FieldSpec = { name: "mic", label: "mic", type: "boolean", defaultValue: true }

export const testCases: TestCase[] = [
  // ---- Playback control -------------------------------------------------
  {
    id: "playSound",
    label: "play_sound",
    group: "Playback",
    autoRun: false,
    fields: [
      { name: "index", label: "index", type: "number", defaultValue: 0 },
      speakersField,
      micField,
    ],
    run: (v) => soundpad.playSound(num(v, "index"), bool(v, "speakers"), bool(v, "mic")),
  },
  {
    id: "playSoundFromCategory",
    label: "play_sound_from_category",
    group: "Playback",
    autoRun: false,
    fields: [
      { name: "categoryIndex", label: "category index", type: "number", defaultValue: 0 },
      { name: "soundIndex", label: "sound index", type: "number", defaultValue: 0 },
      speakersField,
      micField,
    ],
    run: (v) =>
      soundpad.playSoundFromCategory(
        num(v, "categoryIndex"),
        num(v, "soundIndex"),
        bool(v, "speakers"),
        bool(v, "mic"),
      ),
  },
  {
    id: "playPreviousSound",
    label: "play_previous_sound",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.playPreviousSound(),
  },
  {
    id: "playNextSound",
    label: "play_next_sound",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.playNextSound(),
  },
  {
    id: "stopSound",
    label: "stop_sound",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.stopSound(),
  },
  {
    id: "togglePause",
    label: "toggle_pause",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.togglePause(),
  },
  {
    id: "jumpMs",
    label: "jump_ms",
    group: "Playback",
    autoRun: false,
    fields: [{ name: "timeMillis", label: "time millis", type: "number", defaultValue: 1000 }],
    run: (v) => soundpad.jumpMs(num(v, "timeMillis")),
  },
  {
    id: "seekMs",
    label: "seek_ms",
    group: "Playback",
    autoRun: false,
    fields: [{ name: "timeMillis", label: "time millis", type: "number", defaultValue: 0 }],
    run: (v) => soundpad.seekMs(num(v, "timeMillis")),
  },
  {
    id: "playRandomSound",
    label: "play_random_sound",
    group: "Playback",
    autoRun: false,
    fields: [speakersField, micField],
    run: (v) => soundpad.playRandomSound(bool(v, "speakers"), bool(v, "mic")),
  },
  {
    id: "playRandomSoundFromCategory",
    label: "play_random_sound_from_category",
    group: "Playback",
    autoRun: false,
    fields: [
      { name: "categoryIndex", label: "category index", type: "number", defaultValue: 0 },
      speakersField,
      micField,
    ],
    run: (v) =>
      soundpad.playRandomSoundFromCategory(
        num(v, "categoryIndex"),
        bool(v, "speakers"),
        bool(v, "mic"),
      ),
  },
  {
    id: "playSelectedSound",
    label: "play_selected_sound",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.playSelectedSound(),
  },
  {
    id: "playCurrentSoundAgain",
    label: "play_current_sound_again",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.playCurrentSoundAgain(),
  },
  {
    id: "playPreviouslyPlayedSound",
    label: "play_previously_played_sound",
    group: "Playback",
    autoRun: false,
    run: () => soundpad.playPreviouslyPlayedSound(),
  },

  // ---- Library management ---------------------------------------------
  {
    id: "addSound",
    label: "add_sound",
    group: "Library",
    autoRun: false,
    fields: [
      { name: "path", label: "path", type: "text", defaultValue: "" },
      { name: "categoryIndex", label: "category index (opt)", type: "optionalNumber", defaultValue: "" },
      { name: "index", label: "index (opt)", type: "optionalNumber", defaultValue: "" },
    ],
    run: (v) => soundpad.addSound(text(v, "path"), optNum(v, "categoryIndex"), optNum(v, "index")),
  },
  {
    id: "removeSelectedEntries",
    label: "remove_selected_entries",
    group: "Library",
    autoRun: false,
    fields: [
      { name: "removeFromDisk", label: "remove from disk", type: "boolean", defaultValue: false },
    ],
    run: (v) => soundpad.removeSelectedEntries(bool(v, "removeFromDisk")),
  },
  {
    id: "getSoundFileCount",
    label: "get_sound_file_count",
    group: "Library",
    autoRun: true,
    run: () => soundpad.getSoundFileCount(),
  },
  {
    id: "search",
    label: "search",
    group: "Library",
    autoRun: false,
    fields: [{ name: "searchTerm", label: "search term", type: "text", defaultValue: "" }],
    run: (v) => soundpad.search(text(v, "searchTerm")),
  },
  {
    id: "resetSearch",
    label: "reset_search",
    group: "Library",
    autoRun: false,
    run: () => soundpad.resetSearch(),
  },
  {
    id: "selectPreviousHit",
    label: "select_previous_hit",
    group: "Library",
    autoRun: false,
    run: () => soundpad.selectPreviousHit(),
  },
  {
    id: "selectNextHit",
    label: "select_next_hit",
    group: "Library",
    autoRun: false,
    run: () => soundpad.selectNextHit(),
  },
  {
    id: "selectRow",
    label: "select_row",
    group: "Library",
    autoRun: false,
    fields: [{ name: "index", label: "index", type: "number", defaultValue: 0 }],
    run: (v) => soundpad.selectRow(num(v, "index")),
  },
  {
    id: "scrollBy",
    label: "scroll_by",
    group: "Library",
    autoRun: false,
    fields: [{ name: "index", label: "delta", type: "number", defaultValue: 1 }],
    run: (v) => soundpad.scrollBy(num(v, "index")),
  },
  {
    id: "scrollTo",
    label: "scroll_to",
    group: "Library",
    autoRun: false,
    fields: [{ name: "index", label: "index", type: "number", defaultValue: 0 }],
    run: (v) => soundpad.scrollTo(num(v, "index")),
  },
  {
    id: "undo",
    label: "undo",
    group: "Library",
    autoRun: false,
    run: () => soundpad.undo(),
  },
  {
    id: "redo",
    label: "redo",
    group: "Library",
    autoRun: false,
    run: () => soundpad.redo(),
  },

  // ---- Categories -------------------------------------------------------
  {
    id: "addCategory",
    label: "add_category",
    group: "Categories",
    autoRun: false,
    fields: [
      { name: "name", label: "name", type: "text", defaultValue: "Test Category" },
      { name: "parentCategoryIndex", label: "parent index", type: "number", defaultValue: -1 },
    ],
    run: (v) => soundpad.addCategory(text(v, "name"), num(v, "parentCategoryIndex")),
  },
  {
    id: "selectCategory",
    label: "select_category",
    group: "Categories",
    autoRun: false,
    fields: [{ name: "index", label: "index", type: "number", defaultValue: 0 }],
    run: (v) => soundpad.selectCategory(num(v, "index")),
  },
  {
    id: "selectPreviousCategory",
    label: "select_previous_category",
    group: "Categories",
    autoRun: false,
    run: () => soundpad.selectPreviousCategory(),
  },
  {
    id: "selectNextCategory",
    label: "select_next_category",
    group: "Categories",
    autoRun: false,
    run: () => soundpad.selectNextCategory(),
  },
  {
    id: "removeCategory",
    label: "remove_category",
    group: "Categories",
    autoRun: false,
    fields: [{ name: "categoryIndex", label: "category index", type: "number", defaultValue: 0 }],
    run: (v) => soundpad.removeCategory(num(v, "categoryIndex")),
  },

  // ---- Volume / mute ----------------------------------------------------
  {
    id: "getVolume",
    label: "get_volume",
    group: "Volume",
    autoRun: true,
    run: () => soundpad.getVolume(),
  },
  {
    id: "isMuted",
    label: "is_muted",
    group: "Volume",
    autoRun: true,
    run: () => soundpad.isMuted(),
  },
  {
    id: "toggleMute",
    label: "toggle_mute",
    group: "Volume",
    autoRun: false,
    run: () => soundpad.toggleMute(),
  },

  // ---- Status & information ----------------------------------------
  {
    id: "getPlayStatus",
    label: "get_play_status",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getPlayStatus(),
  },
  {
    id: "getPlaybackPosition",
    label: "get_playback_position",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getPlaybackPosition(),
  },
  {
    id: "getPlaybackDuration",
    label: "get_playback_duration",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getPlaybackDuration(),
  },
  {
    id: "getSoundList",
    label: "get_sound_list",
    group: "Status",
    autoRun: true,
    fields: [
      { name: "fromIndex", label: "from (opt)", type: "optionalNumber", defaultValue: "" },
      { name: "toIndex", label: "to (opt)", type: "optionalNumber", defaultValue: "" },
    ],
    run: (v) => soundpad.getSoundList(optNum(v, "fromIndex"), optNum(v, "toIndex")),
  },
  {
    id: "getMainFrameTitleText",
    label: "get_main_frame_title_text",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getMainFrameTitleText(),
  },
  {
    id: "getStatusBarText",
    label: "get_status_bar_text",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getStatusBarText(),
  },
  {
    id: "getVersion",
    label: "get_version",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getVersion(),
  },
  {
    id: "getRemoteControlVersion",
    label: "get_remote_control_version",
    group: "Status",
    autoRun: true,
    run: () => soundpad.getRemoteControlVersion(),
  },
  {
    id: "isCompatible",
    label: "is_compatible",
    group: "Status",
    autoRun: true,
    run: () => soundpad.isCompatible(),
  },
  {
    id: "isAlive",
    label: "is_alive",
    group: "Status",
    autoRun: true,
    run: () => soundpad.isAlive(),
  },
  {
    id: "isTrial",
    label: "is_trial",
    group: "Status",
    autoRun: true,
    run: () => soundpad.isTrial(),
  },

  // ---- Recording ------------------------------------------------------
  {
    id: "startRecording",
    label: "start_recording",
    group: "Recording",
    autoRun: false,
    run: () => soundpad.startRecording(),
  },
  {
    id: "stopRecording",
    label: "stop_recording",
    group: "Recording",
    autoRun: false,
    run: () => soundpad.stopRecording(),
  },
  {
    id: "startRecordingSpeakers",
    label: "start_recording_speakers",
    group: "Recording",
    autoRun: false,
    run: () => soundpad.startRecordingSpeakers(),
  },
  {
    id: "startRecordingMicrophone",
    label: "start_recording_microphone",
    group: "Recording",
    autoRun: false,
    run: () => soundpad.startRecordingMicrophone(),
  },
  {
    id: "getRecordingPosition",
    label: "get_recording_position",
    group: "Recording",
    autoRun: true,
    run: () => soundpad.getRecordingPosition(),
  },
  {
    id: "getRecordingPeak",
    label: "get_recording_peak",
    group: "Recording",
    autoRun: true,
    run: () => soundpad.getRecordingPeak(),
  },
]

export const groups = Array.from(new Set(testCases.map((c) => c.group)))
