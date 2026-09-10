"use client"

import { useSyncExternalStore } from "react"

import { commandMap, defaultKeybinds } from "@/lib/commands"

export type SettingsConfig = {
  schemaVersion: 1
  appearance: {
    theme: "system" | "light" | "dark"
    /** Play the view transition when the theme changes. */
    themeAnimation: boolean
  }
  downloads: {
    /**
     * The folder in use, and the one every other part of the app reads.
     *
     * Empty means the service's own folder, which is the answer before
     * anybody has chosen anything. `folders` is the list this is chosen
     * *from*; this string stays the single source of truth so nothing else
     * has to learn about the list.
     */
    location: string
    /**
     * Folders kept on hand to switch between.
     *
     * Deliberately not a list of *names*: a saved folder is a path and where
     * it came from, nothing else. Naming them is a separate feature and
     * pretending to have it now would mean storing a label that immediately
     * disagrees with the folder it points at.
     */
    folders: DownloadFolder[]
    concurrentDownloads: number
    /**
     * Friendly `{title} [{id}]` form. The extension is never part of it -
     * yt-dlp appends the real one, and a template that names it either
     * doubles it or lies about what was actually downloaded.
     */
    filenameTemplate: string
    filenameCase: "original" | "kebab" | "snake" | "lower" | "title"
    /**
     * Ask where each finished download should go, the way a browser can.
     *
     * The download itself still lands in the service's folder - that is the
     * only place it knows how to write to - and is moved once it is complete
     * and there is something to move.
     */
    askWhereToSave: boolean
    autoStartQueued: boolean
  }
  video: {
    quality: "best" | "1080p" | "720p" | "480p"
    container: "mp4" | "mkv" | "webm"
    embedSubtitles: boolean
  }
  audio: {
    format: "mp3" | "m4a" | "opus" | "wav"
    bitrateKbps: number
    embedMetadata: boolean
    embedThumbnail: boolean
  }
  startup: {
    launchOnStartup: boolean
    reopenLastSection: boolean
    startMinimized: boolean
  }
  /**
   * Keeping the install current - the app and everything it ships with.
   *
   * Only the preferences live here. What the last check *found* does not: it
   * is a result rather than a choice, it changes without anybody touching a
   * control, and putting it here would carry a stale report into every
   * settings export. It has its own store in `lib/updates.ts`.
   */
  updates: {
    /**
     * Run a check shortly after the app opens.
     *
     * The only schedule there is. A recurring timer was tried and taken back
     * out: this is a desktop app that is opened when it is wanted, so launch
     * is when the answer is worth having, and a check that fires at some
     * unpredictable hour is one nobody is present to act on.
     */
    checkOnLaunch: boolean
    /** Say something when a check finds an update, wherever you are. */
    notify: boolean
    /**
     * An override for where this app's releases are read from.
     *
     * Empty is the normal state: the feed this build ships with
     * (`DEFAULT_APP_REPO` in `lib/updates.ts`) is used. Kept as an override
     * rather than a default written in here so that moving the repository is a
     * change to one constant, instead of something every stored config has to
     * be migrated onto. Accepts `owner/repo`, a github.com URL, or the URL of
     * a JSON manifest.
     */
    feedUrl: string
  }
  network: {
    /** 0 means unlimited. */
    rateLimitKBps: number
    retries: number
    proxyUrl: string
  }
  diagnostics: {
    verboseLogging: boolean
    logLevel: "error" | "warn" | "info" | "debug"
  }
  /** Delivering finished audio into a Spotify local-files folder. */
  spotify: {
    enabled: boolean
    /** The install root, as reported by the probe. */
    installation: string
    /** Spotify user id, since one install can hold several accounts. */
    account: string
    /**
     * The chosen local-files folders. Several, because Spotify allows several
     * source folders and a download can belong in more than one of them.
     */
    folders: string[]
    /**
     * Folders the user typed in themselves, rather than ones the probe found.
     *
     * Kept apart so the table can say which is which: a detected folder is one
     * Spotify has confirmed it watches, a manual one is a promise nobody has
     * checked. If the probe later reports a manual folder, it simply becomes
     * detected - there is nothing to migrate, because the two lists answer
     * different questions.
     */
    manualFolders: string[]
    /**
     * True copies and leaves the download in place; false moves it, so the
     * only copy is the one Spotify can see.
     */
    keepOriginal: boolean
    /**
     * Whether the download pane's switch starts on.
     *
     * Separate from `enabled`, which is whether the feature works at all.
     * Someone can have it set up and still want to opt in per track.
     */
    defaultOn: boolean
    /**
     * The bitrate the command menu's "Add to Spotify" downloads at.
     *
     * The command is one keystroke with no dialog in between, so what it
     * produces has to be decided in advance rather than asked for. The format
     * is not here because there is nothing to decide - see
     * `SPOTIFY_AUDIO_FORMAT` - and the top bitrate is the default because a
     * local library is kept rather than streamed once.
     */
    quickBitrateKbps: number
  }
  /**
   * Command id -> chord, for every command that has one. Defaults come from
   * the command registry rather than being written out again here, so adding a
   * command cannot leave a shortcut undefined.
   */
  keybinds: Record<string, string>
}

/** One folder in the save-location list. */
export type DownloadFolder = {
  /**
   * Where the path came from: the id of a folder the OS named
   * (`downloads`, `temporary`, ...) or `custom` for one typed or picked.
   *
   * Kept because it is the only thing that survives a move. A preset can be
   * re-resolved on a machine whose Downloads folder is somewhere else; a
   * custom path is exactly what was asked for and is left alone.
   */
  source: string
  path: string
}

export type SettingsConfigUpdate = (
  updater: (current: SettingsConfig) => SettingsConfig
) => void

export type SettingsSectionComponentProps = {
  config: SettingsConfig
  updateConfig: SettingsConfigUpdate
  resetSettings: () => void
}

export const settingsConfigStorageKey = "inferno-app.settings-config"

export const defaultSettingsConfig: SettingsConfig = {
  schemaVersion: 1,
  appearance: {
    theme: "system",
    themeAnimation: true,
  },
  downloads: {
    location: "",
    folders: [],
    concurrentDownloads: 3,
    filenameTemplate: "{title} [{id}]",
    filenameCase: "original",
    askWhereToSave: false,
    autoStartQueued: true,
  },
  video: {
    quality: "best",
    container: "mp4",
    embedSubtitles: false,
  },
  audio: {
    format: "mp3",
    bitrateKbps: 192,
    embedMetadata: true,
    embedThumbnail: true,
  },
  startup: {
    launchOnStartup: false,
    reopenLastSection: true,
    startMinimized: false,
  },
  updates: {
    checkOnLaunch: true,
    notify: true,
    // Empty means "the feed this build ships with", not "no feed".
    feedUrl: "",
  },
  network: {
    rateLimitKBps: 0,
    retries: 3,
    proxyUrl: "",
  },
  diagnostics: {
    verboseLogging: false,
    logLevel: "info",
  },
  spotify: {
    enabled: false,
    installation: "",
    account: "",
    folders: [],
    manualFolders: [],
    keepOriginal: true,
    defaultOn: false,
    quickBitrateKbps: 320,
  },
  keybinds: defaultKeybinds(),
}

/** An imported or older config may carry anything; only strings are usable. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

/**
 * A stored template, with the extension token taken back out.
 *
 * `{ext}` used to be a token, so configs written before it was removed still
 * end in `.{ext}`. It is not a token any more - yt-dlp appends the real
 * extension itself - so the editor would now show those five characters as
 * ordinary text and the file would come out as `Title.{ext}.mp4`. Stripping it
 * on the way in fixes those configs once, and keeps the token out of the
 * editor rather than teaching the editor about one it must never insert.
 */
function migrateFilenameTemplate(stored: unknown) {
  if (typeof stored !== "string") {
    return defaultSettingsConfig.downloads.filenameTemplate
  }

  // An empty template is a real choice - it means the title - so it is kept
  // rather than replaced with the default. Substituting here undid clearing
  // the field: the value saved empty and came straight back as the default.
  //
  // Not trimmed, either. The stored string is what the editor is rendered
  // from, so trimming a space the moment it is typed rewrites the field's
  // contents underneath the caret.
  //
  // The extension is stripped only at the end: one anywhere else was never
  // what the token was for, and guessing at the intent of it would be worse
  // than leaving it be.
  return stored.replace(/\.?\{ext\}\s*$/i, "")
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Stored bindings over the shipped ones, keeping only commands that still
 * exist.
 *
 * Dropping unknown ids matters: a binding left behind by a deleted command is
 * invisible in the UI but still counts as a conflict, so rebinding its chord
 * would be refused for a reason nobody could see.
 */
/**
 * The saved folder list, taken at arm's length.
 *
 * An imported config can carry anything at all here, and a row with no path
 * would render as a blank line that selects nothing. Duplicates go too: two
 * rows for one folder are two ways to pick the same thing, and only one of
 * them can ever look selected.
 */
function mergeDownloadFolders(stored: unknown): DownloadFolder[] {
  if (!Array.isArray(stored)) {
    return []
  }

  const seen = new Set<string>()

  return stored.flatMap((entry) => {
    const path =
      typeof (entry as DownloadFolder)?.path === "string"
        ? (entry as DownloadFolder).path.trim()
        : ""

    if (!path || seen.has(path)) {
      return []
    }

    seen.add(path)

    const source = (entry as DownloadFolder)?.source

    return [{ path, source: typeof source === "string" ? source : "custom" }]
  })
}

function mergeKeybinds(stored: Record<string, string> | undefined) {
  const merged = defaultKeybinds()

  for (const [id, binding] of Object.entries(stored ?? {})) {
    if (commandMap.has(id) && typeof binding === "string") {
      merged[id] = binding
    }
  }

  return merged
}

/**
 * Merges stored JSON over the defaults one group at a time so a config written
 * by an older build (missing groups, missing keys) still loads instead of
 * leaving `undefined` holes for the section components to read.
 */
function mergeSettingsConfig(
  parsed: Partial<SettingsConfig> | null | undefined
) {
  return {
    ...defaultSettingsConfig,
    ...parsed,
    schemaVersion: 1,
    appearance: {
      ...defaultSettingsConfig.appearance,
      ...parsed?.appearance,
    },
    downloads: {
      ...defaultSettingsConfig.downloads,
      ...parsed?.downloads,
      folders: mergeDownloadFolders(parsed?.downloads?.folders),
      filenameTemplate: migrateFilenameTemplate(
        parsed?.downloads?.filenameTemplate
      ),
      concurrentDownloads: clamp(
        parsed?.downloads?.concurrentDownloads ??
          defaultSettingsConfig.downloads.concurrentDownloads,
        1,
        10
      ),
    },
    video: {
      ...defaultSettingsConfig.video,
      ...parsed?.video,
    },
    audio: {
      ...defaultSettingsConfig.audio,
      ...parsed?.audio,
      bitrateKbps: clamp(
        parsed?.audio?.bitrateKbps ?? defaultSettingsConfig.audio.bitrateKbps,
        64,
        320
      ),
    },
    startup: {
      ...defaultSettingsConfig.startup,
      ...parsed?.startup,
    },
    // Named one key at a time rather than spread, so that settings this group
    // used to have - a recurring frequency, per-tool switches - are dropped on
    // the way in instead of living on invisibly in everyone's stored config
    // and turning up again in an export.
    updates: {
      checkOnLaunch:
        parsed?.updates?.checkOnLaunch ??
        defaultSettingsConfig.updates.checkOnLaunch,
      notify: parsed?.updates?.notify ?? defaultSettingsConfig.updates.notify,
      // An imported config may carry anything here, and the value is put
      // straight into a `fetch`. A non-string falls back to the built-in feed,
      // which is the one safe reading of it.
      feedUrl:
        typeof parsed?.updates?.feedUrl === "string"
          ? parsed.updates.feedUrl
          : defaultSettingsConfig.updates.feedUrl,
    },
    network: {
      ...defaultSettingsConfig.network,
      ...parsed?.network,
      rateLimitKBps: clamp(
        parsed?.network?.rateLimitKBps ??
          defaultSettingsConfig.network.rateLimitKBps,
        0,
        50000
      ),
      retries: clamp(
        parsed?.network?.retries ?? defaultSettingsConfig.network.retries,
        0,
        10
      ),
    },
    diagnostics: {
      ...defaultSettingsConfig.diagnostics,
      ...parsed?.diagnostics,
    },
    spotify: {
      ...defaultSettingsConfig.spotify,
      ...parsed?.spotify,
      // An imported or older config may carry anything here; only a list of
      // strings is usable, and the folders are re-checked against the probe
      // before any of them is written to anyway.
      folders: stringList(parsed?.spotify?.folders),
      manualFolders: stringList(parsed?.spotify?.manualFolders),
      quickBitrateKbps: clamp(
        parsed?.spotify?.quickBitrateKbps ??
          defaultSettingsConfig.spotify.quickBitrateKbps,
        64,
        320
      ),
    },
    keybinds: mergeKeybinds(parsed?.keybinds),
  } satisfies SettingsConfig
}

/**
 * Validate an untrusted settings object - an imported file, most of it.
 *
 * The same merge stored config goes through, exposed under a name that says
 * what it is for. Sharing it is the point: an importer with its own validation
 * would drift out of step with the store the moment a setting was added.
 */
export function mergeImportedSettings(parsed: Partial<SettingsConfig>) {
  return mergeSettingsConfig(parsed)
}

export function createDefaultSettingsConfig() {
  return structuredClone(defaultSettingsConfig)
}

export function loadSettingsConfig() {
  if (typeof window === "undefined") {
    return createDefaultSettingsConfig()
  }

  const raw = window.localStorage.getItem(settingsConfigStorageKey)

  if (!raw) {
    return createDefaultSettingsConfig()
  }

  try {
    return mergeSettingsConfig(JSON.parse(raw) as Partial<SettingsConfig>)
  } catch {
    return createDefaultSettingsConfig()
  }
}

export function saveSettingsConfig(config: SettingsConfig) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(settingsConfigStorageKey, JSON.stringify(config))
  window.dispatchEvent(
    new CustomEvent("inferno-app:settings-config-changed", { detail: config })
  )
}

/**
 * Subscribe to the stored config.
 *
 * `localStorage` is an external store, so this is `useSyncExternalStore` rather
 * than a read in an effect: the effect version renders once with defaults and
 * then immediately again with the real values, which is both a cascading render
 * and a visible flash of the wrong download folder.
 *
 * The snapshot is cached against the raw JSON because `getSnapshot` has to
 * return a stable reference - parsing afresh on every call would hand React a
 * new object each time and loop forever.
 */
let snapshotSource: string | null = null
let snapshotValue: SettingsConfig = defaultSettingsConfig

function getSettingsSnapshot(): SettingsConfig {
  const raw = window.localStorage.getItem(settingsConfigStorageKey)
  if (raw !== snapshotSource) {
    snapshotSource = raw
    snapshotValue = raw
      ? mergeSettingsConfig(safeParse(raw))
      : defaultSettingsConfig
  }

  return snapshotValue
}

function safeParse(raw: string): Partial<SettingsConfig> | null {
  try {
    return JSON.parse(raw) as Partial<SettingsConfig>
  } catch {
    return null
  }
}

/** Prerendered by `output: "export"`, where there is no storage to read. */
function getServerSettingsSnapshot(): SettingsConfig {
  return defaultSettingsConfig
}

function subscribeToSettings(onChange: () => void) {
  // The settings screen broadcasts this; `storage` covers a second window.
  window.addEventListener("inferno-app:settings-config-changed", onChange)
  window.addEventListener("storage", onChange)

  return () => {
    window.removeEventListener("inferno-app:settings-config-changed", onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function useSettingsConfig(): SettingsConfig {
  return useSyncExternalStore(
    subscribeToSettings,
    getSettingsSnapshot,
    getServerSettingsSnapshot
  )
}
