/**
 * Putting finished audio into Spotify's local-files folders.
 *
 * Spotify plays anything it finds in a folder the user has added under
 * Settings > Local Files, so a download can be delivered into a library with no
 * API, no account linking and no upload. The awkward part is that Spotify will
 * not tell anyone where those folders are, so the Rust side works it out from
 * the state it leaves on disk - see `src-tauri/src/addons/spotify/probe.rs`.
 */

import { askAboutConflict, type ConflictDecision } from "./spotify-conflicts"

export type SpotifyKind = "desktop" | "microsoft-store"

export type SpotifyFolder = {
  path: string
  /** Listed by Spotify but gone from disk - a removed drive, a deleted folder. */
  exists: boolean
  /** Playable files in it now, whatever Spotify believes. */
  audio_files: number
  /** Tracks Spotify has indexed. Zero is fine: configured but empty. */
  indexed_tracks: number
}

export type SpotifyAccount = {
  user_id: string
  profile_dir: string
  folders: SpotifyFolder[]
}

export type SpotifyInstallation = {
  /** The install root. Stable across restarts, so settings can store it. */
  id: string
  kind: SpotifyKind
  label: string
  accounts: SpotifyAccount[]
}

export type SpotifySurvey = {
  installations: SpotifyInstallation[]
  /**
   * Spotify is installed, but not one account lists a folder.
   *
   * Its own flag rather than something inferred from empty arrays, because it
   * is the case that needs explaining: local files are switched off, or no
   * source folder has been added - and Spotify has to be restarted after
   * either change before it writes the files this reads.
   */
  needs_local_files_enabled: boolean
}

export type SpotifyTrack = {
  path: string
  file_name: string
  title: string | null
  artist: string | null
  album: string | null
  /** A `data:` URI, ready for an `img` tag. Absent when the file has no cover. */
  artwork: string | null
  size: number
  /** Seconds since the epoch. */
  modified: number | null
}

export type PlacementOutcome =
  "placed" | "replaced" | "kept_both" | "skipped" | "conflict"

export type ExistingFile = {
  path: string
  name: string
  size: number
  modified: number | null
}

export type Placement = {
  outcome: PlacementOutcome
  /** Where it ended up. Null when nothing was written. */
  path: string | null
  kept_original: boolean
  /** The file in the way, when there is one. */
  existing: ExistingFile | null
}

/**
 * What Spotify will actually play from a local-files folder.
 *
 * Its own list, and a short one: mp3, mp4 and m4p. Two exclusions matter here
 * because they are exactly what this app produces by default:
 *
 * * **m4a is not supported.** Spotify names it explicitly as unsupported, so
 *   the app's default audio format cannot be delivered - the file would sit in
 *   the folder being quietly ignored, which is worse than refusing it.
 * * **mp4 must be audio-only.** A video track makes it unplayable as a local
 *   file, so mp4 only counts here for an audio-mode download.
 *
 * Checked twice on purpose: once at configure time from the chosen format, so
 * the toggle can say why it is unavailable, and again on the finished file,
 * because the extension on disk is the only thing that is actually true.
 */
export const SPOTIFY_EXTENSIONS = ["mp3", "mp4", "m4p"] as const

/**
 * Whether there is anywhere to deliver to.
 *
 * A folder, specifically - not the master switch. Somewhere to put the file is
 * what makes the offer keepable, and Settings is where a missing one gets
 * fixed. Shared so the panel and the command menu cannot disagree about when
 * Spotify is on offer.
 */
export function spotifyDeliveryReady(spotify: { folders: string[] }) {
  return spotify.folders.length > 0
}

/**
 * What anything bound for Spotify is downloaded as.
 *
 * A constant rather than a setting. Of the formats this app produces, MP3 is
 * the only one Spotify's local files will play - so a choice here would be a
 * menu with one item in it and a way to get it wrong.
 */
export const SPOTIFY_AUDIO_FORMAT = "mp3"

/** Whether a finished file is one Spotify can play. */
export function isSpotifyCompatible(pathOrName: string) {
  const extension = pathOrName.split(".").pop()?.toLowerCase() ?? ""

  return (SPOTIFY_EXTENSIONS as readonly string[]).includes(extension)
}

/**
 * Whether an audio-mode download will produce something Spotify can play.
 *
 * `keep` is refused rather than guessed at: it leaves whatever the site served,
 * which on YouTube is opus in webm - so the honest answer before the download
 * exists is no.
 */
export function spotifySupportsFormat(audioFormat: string) {
  return isSpotifyCompatible(`x.${audioFormat.toLowerCase()}`)
}

/** Why the toggle is unavailable, or null when it is not. */
export function spotifyFormatProblem(mode: string, audioFormat: string) {
  if (mode !== "audio") {
    return "Only audio downloads can go to Spotify local files."
  }
  if (audioFormat === "keep") {
    return "Pick a format - Spotify cannot play the stream as downloaded."
  }
  if (!spotifySupportsFormat(audioFormat)) {
    return `Spotify cannot play ${audioFormat.toUpperCase()} local files. Use MP3.`
  }

  return null
}

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function call<T>(command: string, args?: Record<string, unknown>) {
  if (!inTauri()) {
    return null
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    const message =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    throw new Error(message)
  }
}

/**
 * Look for Spotify, its accounts, and the folders they watch.
 *
 * Deliberately not cached. The setup screen's whole job is to say "turn local
 * files on and restart Spotify", and the answer has to be able to change when
 * someone does exactly that.
 */
export function surveySpotify() {
  return call<SpotifySurvey>("spotify_survey")
}

/**
 * Deliver one finished file into a folder.
 *
 * `keepOriginal` is the difference between the two modes: true copies and
 * leaves the download where it is, false moves it so the only copy is the one
 * Spotify can see.
 */
export function placeInSpotify(
  source: string,
  folder: string,
  keepOriginal: boolean,
  onConflict: "ask" | ConflictDecision = "ask"
) {
  return call<Placement>("spotify_place", {
    source,
    folder,
    keepOriginal,
    onConflict,
  })
}

/**
 * What is known about one folder in the table.
 *
 * Four states, because they call for four different things from the person
 * reading them - and collapsing any pair of them would hide the one fact that
 * matters: whether Spotify has actually confirmed it is watching the folder.
 */
export type FolderStatus =
  /** The probe found it. Spotify has this folder in its own list. */
  | "detected"
  /** Added by hand and really on disk, but Spotify has not confirmed it. */
  | "manual"
  /** Spotify listed it once and no longer does, though it is still on disk. */
  | "unwatched"
  /** Not on this machine: a removed drive, a deleted or renamed folder. */
  | "unavailable"

export type FolderRow = {
  path: string
  status: FolderStatus
  exists: boolean
  audioFiles: number
  indexedTracks: number
  enabled: boolean
}

/**
 * Every folder worth showing, and what each one's situation is.
 *
 * The union of what the probe found, what was added by hand, and whatever is
 * already switched on - because a folder that has stopped being reported must
 * not silently vanish from a table that is still delivering to it.
 *
 * Detection wins over everything: a manual folder that the probe later reports
 * simply becomes `detected`, which is the "update its status" case without any
 * migration step.
 */
export function folderRows(
  detected: SpotifyFolder[],
  manual: string[],
  enabled: string[]
): FolderRow[] {
  const byPath = new Map<string, FolderRow>()

  for (const folder of detected) {
    byPath.set(folder.path, {
      path: folder.path,
      status: folder.exists ? "detected" : "unavailable",
      exists: folder.exists,
      audioFiles: folder.audio_files,
      indexedTracks: folder.indexed_tracks,
      enabled: enabled.includes(folder.path),
    })
  }

  const addUndetected = (path: string, status: FolderStatus) => {
    if (byPath.has(path)) {
      return
    }
    byPath.set(path, {
      path,
      // Whether it is on disk is not known here - the probe only measures what
      // it found - so an undetected folder is reported as its own status and
      // the row does not claim a file count it cannot back up.
      status,
      exists: true,
      audioFiles: 0,
      indexedTracks: 0,
      enabled: enabled.includes(path),
    })
  }

  for (const path of manual) {
    addUndetected(path, "manual")
  }
  for (const path of enabled) {
    addUndetected(path, "unwatched")
  }

  return [...byPath.values()].sort((a, b) => {
    const rank: Record<FolderStatus, number> = {
      detected: 0,
      manual: 1,
      unwatched: 2,
      unavailable: 3,
    }

    return rank[a.status] - rank[b.status] || a.path.localeCompare(b.path)
  })
}

/** What each status means, for the badge's tooltip and the row's own copy. */
export const FOLDER_STATUS_TEXT: Record<
  FolderStatus,
  { label: string; detail: string }
> = {
  detected: {
    label: "Detected",
    detail: "Spotify lists this as one of its local-files folders.",
  },
  manual: {
    label: "Manual",
    detail:
      "You added this yourself. Spotify has not confirmed it is watching it - add it under Settings > Local Files in Spotify, then restart Spotify.",
  },
  unwatched: {
    label: "Not watched",
    detail:
      "Spotify listed this folder before and no longer does. Files delivered here will not appear in Spotify until it is added again.",
  },
  unavailable: {
    label: "Unavailable",
    detail: "This folder is not on this machine any more.",
  },
}

/** Ask for a folder to add by hand. Null when the picker was dismissed. */
export function pickSpotifyFolder() {
  return call<string | null>("spotify_pick_folder")
}

/** The folder a stored choice points at, if it is still being offered. */
export function findFolder(
  survey: SpotifySurvey | null,
  installationId: string,
  accountId: string,
  folderPath: string
) {
  return (
    survey?.installations
      .find((install) => install.id === installationId)
      ?.accounts.find((account) => account.user_id === accountId)
      ?.folders.find((folder) => folder.path === folderPath) ?? null
  )
}

/**
 * Deliver one file into every chosen folder, asking about anything in the way.
 *
 * The single path both callers use - the automatic delivery after a download
 * and the row menu's "Add to Spotify" - so a conflict cannot be handled one way
 * in one place and another way in the other.
 *
 * `keepOriginal` may be false only for the *last* folder: the earlier ones need
 * the file to still be there. A skipped last folder therefore also leaves the
 * original alone, which is what `kept_original` reports back.
 */
export async function deliverToFolders(
  source: string,
  folders: string[],
  keepOriginal: boolean
) {
  const failures: string[] = []
  let delivered = 0
  let skipped = 0
  let moved = false
  let finalPath = source

  /** Set once someone answers "do this for the rest". */
  let standing: ConflictDecision | null = null

  for (const [index, folder] of folders.entries()) {
    const last = index === folders.length - 1
    const keep = keepOriginal || !last

    try {
      let placed = await placeInSpotify(source, folder, keep, standing ?? "ask")

      if (placed?.outcome === "conflict" && placed.existing) {
        const answer = await askAboutConflict({
          incomingName: source.split(/[\\/]/).pop() ?? source,
          incomingSize: 0,
          existingName: placed.existing.name,
          existingSize: placed.existing.size,
          existingModified: placed.existing.modified,
          folder,
          remaining: folders.length - index - 1,
        })

        if (answer.applyToRest) {
          standing = answer.decision
        }

        placed = await placeInSpotify(source, folder, keep, answer.decision)
      }

      if (!placed) {
        continue
      }

      if (placed.outcome === "skipped") {
        skipped += 1
        continue
      }

      delivered += 1
      if (placed.path && !placed.kept_original) {
        finalPath = placed.path
        moved = true
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : `Could not use ${folder}`
      )
    }
  }

  return { delivered, skipped, failures, moved, finalPath }
}

/**
 * The audio files in one folder, with their tags.
 *
 * Reads the head of every file to find them, so this is only asked for when
 * someone opens the listing - never as part of the settings screen loading.
 * Capped at 500, newest first: what was just delivered is what anyone is
 * actually looking for.
 */
export function listSpotifyTracks(folder: string) {
  return call<SpotifyTrack[]>("spotify_folder_tracks", { folder })
}
