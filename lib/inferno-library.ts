/**
 * The local download library.
 *
 * A SQLite record, app-side, of everything that has finished downloading. The
 * service's jobs are in-memory and vanish on restart (SPEC §2), so this is
 * what makes history survive a relaunch - and it is where the app tracks
 * something the HTTP API has no business knowing: whether the file is still
 * where it was put.
 *
 * Every call is a no-op outside Tauri, where there is no database.
 */

import type { Job, VideoInfo } from "./inferno-service"

/** Whether the file is still where the record says it is. */
export type FileState = "present" | "missing" | "mismatched" | "unknown"

export type LibraryEntry = {
  id: number
  job_id: string
  url: string
  title: string | null
  channel: string | null
  thumbnail: string | null
  duration: number | null
  mode: string | null
  format_summary: string | null
  directory: string | null
  file_path: string | null
  file_name: string | null
  size: number | null
  content_hash: string | null
  hash_algorithm: string | null
  state: FileState
  downloaded_at: number
  verified_at: number | null
  /**
   * Everything the service knew about the video, kept verbatim so the details
   * view still works once the service has forgotten the job (its jobs are
   * in-memory - SPEC §2).
   */
  video: VideoInfo | null
}

export type RecordedDownload = {
  job_id: string
  url: string
  title: string | null
  channel: string | null
  thumbnail: string | null
  duration: number | null
  mode: string | null
  format_summary: string | null
  directory: string | null
  file_path: string | null
  file_name: string | null
  video: VideoInfo | null
}

export type Relocation = {
  /** The updated record. Only set once something was actually committed. */
  entry: LibraryEntry | null
  /** Whether the chosen file matches the original download's signature. */
  matched: boolean
  /** The picker was dismissed. Nothing changed. */
  cancelled: boolean
  /** What was picked, when it did not match and so was not applied. */
  candidate: string | null
}

export type LibrarySummary = { total: number; missing: number }

/** What actually happened to the file when a download was deleted. */
export type Deletion = {
  deleted: boolean
  /** Nothing to remove - already moved or deleted elsewhere. */
  already_gone: boolean
  /** Why it could not be removed; the record was kept if so. */
  problem: string | null
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
    // Rust hands back a serialised `LibraryError` - `{ kind, message }`.
    const message =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    throw new Error(message)
  }
}

/**
 * The media file a person means by "the download", rather than a thumbnail or
 * a subtitle sidecar that happens to sort first.
 */
export function primaryFile(job: Job) {
  const files = job.files ?? []
  if (files.length === 0) {
    return null
  }

  const media = files.filter(
    (file) =>
      file.mime?.startsWith("video/") ||
      file.mime?.startsWith("audio/") ||
      /\.(mp4|mkv|webm|mov|avi|flv|mp3|m4a|opus|flac|wav|ogg)$/i.test(file.name)
  )

  return (media.length > 0 ? media : files).reduce((best, file) =>
    file.size > best.size ? file : best
  )
}

/** `MP4 1080p` / `MP3 192k` - kept for the library long after the job is gone. */
function formatSummary(job: Job) {
  const options = job.options ?? {}
  const parts: string[] = []

  if (options.mode === "audio") {
    parts.push((options.audio_format ?? "audio").toUpperCase())
    if (options.audio_quality) {
      parts.push(`${options.audio_quality}k`)
    }
  } else {
    if (options.container) {
      parts.push(options.container.toUpperCase())
    }
    if (options.quality && options.quality !== "best") {
      parts.push(options.quality)
    }
  }

  return parts.join(" ") || null
}

/**
 * Persist a finished job. Rust hashes the file here, once - never on a read -
 * so a moved file can be recognised later.
 */
export function recordDownload(job: Job) {
  const file = primaryFile(job)

  const download: RecordedDownload = {
    job_id: job.job_id,
    url: job.url,
    title: job.video?.title ?? null,
    channel: job.video?.channel ?? job.video?.uploader ?? null,
    thumbnail: job.video?.thumbnail ?? null,
    duration: job.video?.duration ?? null,
    mode: job.options?.mode ?? null,
    format_summary: formatSummary(job),
    directory: job.directory ?? null,
    file_path: file?.path ?? null,
    file_name: file?.name ?? null,
    // The whole metadata object, not just the few fields the row shows.
    video: job.video ?? null,
  }

  return call<LibraryEntry>("library_record", { download })
}

export function listLibrary(limit = 500) {
  return call<LibraryEntry[]>("library_list", { limit })
}

export function librarySummary() {
  return call<LibrarySummary>("library_summary")
}

/**
 * Re-check one entry: an existence check only, no hashing. Cheap enough to run
 * when a menu opens, which is the only time it runs - nothing polls.
 */
export function verifyEntry(id: number) {
  return call<LibraryEntry>("library_verify", { id })
}

/** Drop the record. The file stays on disk. */
export function forgetEntry(id: number) {
  return call<void>("library_forget", { id })
}

/**
 * Delete the file as well as the record.
 *
 * The library's path wins over the job's: after a relocate the file is
 * wherever the user put it, and that is the copy they mean.
 */
export function deleteEntry(id: number) {
  return call<Deletion>("library_delete", { id })
}

/**
 * Open the system file picker and compare what they choose.
 *
 * A file that does not match the stored signature is *not* applied - it comes
 * back as `candidate` so the person looking at it can decide, since only they
 * know whether they edited the file or picked the wrong one. `relocateEntry`
 * is the "use it anyway" half.
 */
export function locateEntry(id: number) {
  return call<Relocation>("library_locate", { id })
}

/** Point the record at a file the user chose despite the mismatch. */
export function relocateEntry(id: number, path: string) {
  return call<LibraryEntry>("library_relocate", { id, path })
}
