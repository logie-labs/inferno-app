/**
 * The client for `inferno-service`.
 *
 * Everything the app does goes through the service's public HTTP + WebSocket
 * API - the same one the CLI and the bundled web client use. There is no
 * privileged path and none should be added: if the app needs something the API
 * cannot express, the API grows, not this file.
 *
 * Mirrors `lib/tauri-window.ts`: the same bundle is served by
 * `npm run dev:web` in a plain browser, where the Tauri API is absent. There
 * the endpoint falls back to `INFERNO_SERVICE_URL`-style defaults so the UI can
 * still be driven against a service started by hand.
 */

export type ServiceEndpoint = {
  base_url: string
  token: string
}

export type ServiceStatus = {
  base_url: string | null
  origin: "bundled" | "development" | "attached" | null
  managed: boolean
  /** `null` while the child is alive; its exit status once it is not. */
  exited: string | null
  /** Why there is no service, carrying the child's stderr when it had any. */
  error: string | null
}

/** Every failure the service reports, including framework 404s (SPEC §4). */
export type ServiceErrorBody = {
  code: string
  message: string
  detail?: Record<string, unknown>
}

export type JobStatus =
  | "queued"
  | "extracting"
  | "downloading"
  | "postprocessing"
  | "completed"
  | "failed"
  | "cancelled"

export const terminalStatuses: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
]

/** One progress tick. Raw values only - presentation is the client's job. */
export type ProgressData = {
  status?: string
  downloaded_bytes?: number | null
  total_bytes?: number | null
  total_bytes_estimate?: number | null
  percent?: number | null
  speed?: number | null
  eta?: number | null
  elapsed?: number | null
  fragment_index?: number | null
  fragment_count?: number | null
  filename?: string | null
  /** Percent restarts between streams on a merge; this tells the passes apart. */
  format_id?: string | null
  ext?: string | null
  /** Which pass this is. `"none"` means the stream carries no such track. */
  vcodec?: string | null
  acodec?: string | null
}

export type PostprocessorData = {
  status?: string
  postprocessor?: string | null
  filename?: string | null
}

export type ServiceFile = {
  name: string
  size: number
  mime?: string | null
  modified?: number | null
  url: string
  /** Absolute local path, for opening or revealing. Bytes come from `url`. */
  path?: string | null
}

/** One row in a directory listing from `/api/v1/files`. */
export type FileEntry = {
  name: string
  /** Relative to the download root - what to pass back to browse or fetch. */
  path: string
  type: "file" | "directory"
  /** Null for a directory; a directory's size is not a thing worth computing. */
  size: number | null
  mime?: string | null
  modified?: number | null
  /** Null for a directory. Relative, like every other url the API returns. */
  url: string | null
}

export type FileListing = {
  /** Relative to the root; empty string *is* the root. */
  path: string
  /** Null at the root, so "up" has exactly one representation. */
  parent: string | null
  /** For display. "Downloads" at the root, the folder's own name below it. */
  name: string
  entries: FileEntry[]
  count: number
}

export type Chapter = {
  title?: string | null
  start_time?: number | null
  end_time?: number | null
}

/** `{ en: [{ ext, url, name }], de: [...] }` - language code to tracks. */
export type SubtitleTracks = Record<
  string,
  { ext?: string | null; url?: string | null; name?: string | null }[]
>

export type VideoFormat = {
  format_id: string
  format_note?: string | null
  ext?: string | null
  resolution?: string | null
  fps?: number | null
  vcodec?: string | null
  acodec?: string | null
  has_video?: boolean
  has_audio?: boolean
  filesize?: number | null
  filesize_approx?: number | null
  abr?: number | null
  tbr?: number | null
}

export type VideoInfo = {
  id?: string | null
  title?: string | null
  description?: string | null
  duration?: number | null
  thumbnail?: string | null
  uploader?: string | null
  channel?: string | null
  channel_url?: string | null
  channel_follower_count?: number | null
  webpage_url?: string | null
  original_url?: string | null
  extractor_key?: string | null
  upload_date?: string | null
  view_count?: number | null
  like_count?: number | null
  comment_count?: number | null
  availability?: string | null
  license?: string | null
  age_limit?: number | null
  is_live?: boolean
  was_live?: boolean
  live_status?: string | null
  categories?: string[]
  tags?: string[]
  chapters?: Chapter[]
  formats?: VideoFormat[]
  subtitles?: SubtitleTracks
  automatic_captions?: SubtitleTracks
  [key: string]: unknown
}

/** The **resolved** options, not the ones sent (SPEC §6). */
export type ResolvedOptions = {
  mode?: "video" | "audio"
  quality?: string | null
  container?: string | null
  audio_format?: string | null
  audio_quality?: number | null
  /** Two streams are expected when this is set - the download bar's divisor. */
  merging?: boolean
  /** The postprocessing steps this job will run, in order.  */
  postprocessors?: string[]
  [key: string]: unknown
}

export type Job = {
  job_id: string
  url: string
  status: JobStatus
  options?: ResolvedOptions
  /** The job's output folder, for "open file location". */
  directory?: string | null
  video?: VideoInfo | null
  progress?: ProgressData | null
  files?: ServiceFile[]
  error?: ServiceErrorBody | null
  created_at: number
  started_at?: number | null
  finished_at?: number | null
  elapsed?: number | null
  ws_url?: string | null
}

export type DownloadRequest = {
  url: string
  mode?: "video" | "audio"
  quality?: string
  format_id?: string
  audio_format?: string
  audio_quality?: number
  container?: string
  playlist?: boolean
  subtitles?: string[]
  auto_subtitles?: boolean
  embed_subtitles?: boolean
  write_thumbnail?: boolean
  embed_thumbnail?: boolean
  embed_metadata?: boolean
  output_template?: string
  /** Applied when the file is published; yt-dlp templates cannot case. */
  filename_case?: "original" | "kebab" | "snake" | "lower" | "title"
  concurrent_fragments?: number
  /** Bytes per second. See `toRateLimitBytes` for the app's own unit. */
  rate_limit?: number
}

export type PlaylistInfo = {
  id?: string | null
  title?: string | null
  entries?: VideoInfo[]
  [key: string]: unknown
}

/**
 * `GET /api/v1/info` wraps its result. A single video fills `video`; a
 * playlist URL fills `playlist` and leaves `video` null - so a caller that
 * reads `title` off this envelope silently gets nothing.
 */
export type InfoResponse = {
  url: string
  cached: boolean
  video: VideoInfo | null
  playlist: PlaylistInfo | null
}

/** What `/health` reports. Self-describing capabilities (SPEC §8). */
export type Health = {
  status: string
  version?: string
  yt_dlp_version?: string | null
  /** Where the service actually writes, whatever the app's own setting says. */
  download_dir?: string | null
  max_concurrent?: number
  python_version?: string | null
  /**
   * ffprobe is named separately from ffmpeg because it fails separately: it is
   * resolved beside ffmpeg rather than with it, and a bundle that renames the
   * binaries leaves ffmpeg working and ffprobe missing. Anything reporting on
   * the install has to be able to tell those two apart.
   */
  ffmpeg?: ResolvedBinary
  ffprobe?: ResolvedBinary
  js_runtime?: ResolvedBinary & { name?: string | null }
  cookies?: boolean
  [key: string]: unknown
}

/** How `/health` describes one binary it resolved (SPEC §8). */
export type ResolvedBinary = {
  path?: string | null
  /** Which arm of `env -> bundled -> PATH` won. */
  source?: string | null
  version?: string | null
  available?: boolean
  error?: string | null
}

/** One frame off the firehose. The shape is fixed; only type and data vary. */
export type ServiceEvent = {
  type: string
  job_id: string | null
  ts: number
  seq: number
  data: Record<string, unknown>
}

/**
 * Thrown for every non-2xx response, carrying the service's own error code.
 * Switch on `code`, never on the message.
 */
export class InfernoError extends Error {
  readonly code: string
  readonly detail: Record<string, unknown>
  readonly httpStatus: number

  constructor(body: ServiceErrorBody, httpStatus = 0) {
    super(body.message)
    this.name = "InfernoError"
    this.code = body.code
    this.detail = body.detail ?? {}
    this.httpStatus = httpStatus
  }
}

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Where the service is and how to authenticate against it.
 *
 * Inside Tauri this comes from Rust, which spawned the process and minted the
 * token. In a plain browser it falls back to the service's own default origin,
 * so `npm run dev:web` works against a hand-started service.
 */
export async function getServiceEndpoint(): Promise<ServiceEndpoint | null> {
  if (!inTauri()) {
    if (typeof window === "undefined") {
      return null
    }

    // Served *by* the service itself, or the Next dev server beside it.
    const origin = window.location.origin.startsWith("http")
      ? window.location.origin
      : ""

    return {
      base_url: origin.includes(":3000") ? "http://127.0.0.1:8765" : origin,
      token: "",
    }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<ServiceEndpoint | null>("inferno_service_endpoint")
  } catch {
    return null
  }
}

export async function getServiceStatus(): Promise<ServiceStatus | null> {
  if (!inTauri()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<ServiceStatus | null>("inferno_service_status")
  } catch {
    return null
  }
}

/**
 * Hand a finished download to the OS. Only "open" and "show me where it is" -
 * the bytes always come from the API. No-ops outside Tauri, where there is no
 * shell to hand it to.
 */
async function shell(command: string, value: string) {
  if (!inTauri()) {
    throw new InfernoError({
      code: "not_supported",
      message: "Opening files is only available in the desktop app.",
    })
  }

  const { invoke } = await import("@tauri-apps/api/core")
  try {
    // Both commands name their single argument for what it is.
    await invoke(
      command,
      command === "inferno_open_url" ? { url: value } : { path: value }
    )
  } catch (cause) {
    // Rust hands back a serialised `ServiceError` - `{ kind, message }` - not
    // an Error, so unwrap it into the same envelope everything else uses.
    const message =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    throw new InfernoError({ code: "shell_failed", message })
  }
}

export function openPath(path: string) {
  return shell("inferno_open_path", path)
}

/**
 * The deepest part of a path that still exists.
 *
 * One call, at most one `exists` per path segment. Used to show where a
 * missing file's trail goes cold, so it is asked once when the dialog opens
 * rather than on every render.
 */
export async function existingAncestor(path: string) {
  if (!inTauri()) {
    return null
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<string | null>("inferno_existing_ancestor", { path })
  } catch {
    return null
  }
}

/**
 * Open a web link in the user's browser.
 *
 * Rust accepts only plain `http(s)` URLs - this window is the application, so
 * nothing here should navigate it away, and a handler is not somewhere to send
 * an arbitrary scheme.
 */
export type DirectoryStatus =
  | "ok"
  | "will_create"
  | "not_a_directory"
  | "unwritable"
  | "no_parent"
  | "invalid"

export type DirectoryCheck = {
  status: DirectoryStatus
  /** Already phrased for a person to read. */
  message: string
  /** The deepest part that exists, when the folder itself does not. */
  existing_parent: string | null
}

/**
 * Judge a folder someone has typed, before anything is downloaded into it.
 *
 * Writability is tested by writing, on the Rust side - there is no reliable
 * way to ask Windows - so this touches the disk and should be debounced rather
 * than run on every keystroke.
 */
export async function checkDirectory(
  path: string
): Promise<DirectoryCheck | null> {
  if (!inTauri()) {
    return null
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<DirectoryCheck>("inferno_check_directory", { path })
  } catch {
    return null
  }
}

/**
 * The system folder picker, opened where the field already points.
 *
 * Null covers both cancelling and there being no picker at all, which is the
 * same thing as far as the caller is concerned: nothing was chosen, so leave
 * what is there alone.
 */
export async function pickDirectory(start?: string): Promise<string | null> {
  if (!inTauri()) {
    return null
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<string | null>("inferno_pick_directory", {
      start: start?.trim() || null,
    })
  } catch {
    return null
  }
}

/**
 * Move a finished download into the folder it was meant to end up in.
 *
 * The service publishes into its own download folder and its request has no
 * field for anywhere else, so a destination the app knows about is applied
 * afterwards, here. Resolves to the path it landed at, which is not
 * necessarily the one asked for - a name already taken is numbered.
 */
export async function placeDownload(source: string, folder: string) {
  if (!inTauri()) {
    return null
  }

  const { invoke } = await import("@tauri-apps/api/core")

  return await invoke<string>("inferno_place_download", { source, folder })
}

export function openUrl(url: string) {
  return shell("inferno_open_url", url)
}

export function revealPath(path: string) {
  return shell("inferno_reveal_path", path)
}

/**
 * Is the file the service resolved still on disk?
 *
 * `/health` cannot answer this: the service resolves its binaries once at
 * startup and caches the result, so a file deleted afterwards still reports as
 * present. Null outside Tauri, where there is no filesystem to ask about -
 * which is not the same answer as `false`.
 */
export async function verifyBinary(path: string): Promise<boolean | null> {
  if (!inTauri()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<boolean>("inferno_verify_binary", { path })
  } catch {
    return null
  }
}

/**
 * Where a vendored binary belongs, whether or not one is there now.
 *
 * `bundled` is the plain path inside the vendor tree - `js/qjs` - and the
 * platform's extension is added on the other side. Needed for the case where
 * nothing resolved at all: `/health` then reports no path, so a repair has to
 * be told where the file goes rather than where it was.
 */
export async function vendorPath(bundled: string): Promise<string | null> {
  if (!inTauri()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<string>("inferno_vendor_path", { bundled })
  } catch {
    return null
  }
}

/** How far along a download is. `total` is 0 when nobody could say. */
/**
 * Fetch a replacement binary over HTTPS, reporting progress as it goes.
 *
 * Done in Rust because GitHub serves release assets with no
 * `Access-Control-Allow-Origin`, so the webview's own `fetch` is refused
 * before it starts.
 */
export async function downloadBinary(
  path: string,
  url: string,
  sha256?: string,
  /**
   * When the download is an archive: which files to lift out of it. Matched on
   * file name alone, because these archives wrap everything in a folder named
   * after the version.
   */
  extract?: Array<{ name: string; destination: string }>,
  /**
   * Where the build's own digest is published, when it is not handed over
   * directly. Fetched on the Rust side - these files sit on the build host's
   * site, which sends no CORS headers.
   */
  checksumUrl?: string
): Promise<string> {
  if (!inTauri()) {
    throw new InfernoError({
      code: "not_supported",
      message: "Downloading files is only available in the desktop app.",
    })
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<string>("inferno_download_binary", {
      path,
      url,
      sha256: sha256 ?? null,
      checksumUrl: checksumUrl ?? null,
      extract: extract ?? null,
    })
  } catch (cause) {
    throw new InfernoError({
      code: "download_failed",
      message:
        typeof cause === "string"
          ? cause
          : ((cause as { message?: string })?.message ??
            "The download failed."),
    })
  }
}

/** A folder the operating system already has a name for. */
export type KnownFolder = {
  /** Stable across machines and languages, unlike the path or the label. */
  id: string
  label: string
  path: string
  exists: boolean
}

/**
 * The folders worth offering without anybody typing a path.
 *
 * Asked of the OS rather than assembled here: `~/Downloads` is wrong on a
 * machine where the folder has been redirected, and wrong in every language
 * that does not call it that. Empty outside Tauri, where there is nothing to
 * ask.
 */
export async function knownFolders(): Promise<KnownFolder[]> {
  if (!inTauri()) {
    return []
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<KnownFolder[]>("inferno_known_folders")
  } catch {
    return []
  }
}

/**
 * SHA-256 of a file on disk, or null where there is no answer to be had.
 *
 * Null rather than a throw for both "not running in Tauri" and "could not be
 * read": every caller so far wants a digest to *display*, and a missing one is
 * a blank line rather than a failure worth interrupting anybody over.
 */
export async function hashFile(path: string): Promise<string | null> {
  if (!inTauri()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")

    return await invoke<string>("inferno_hash_file", { path })
  } catch {
    return null
  }
}

/** A bound client. Cheap to construct; hold one per endpoint. */
export class InfernoClient {
  constructor(private readonly endpoint: ServiceEndpoint) {}

  get baseUrl() {
    return this.endpoint.base_url
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.endpoint.token) {
      headers.set("X-API-Key", this.endpoint.token)
    }
    if (init.body) {
      headers.set("Content-Type", "application/json")
    }

    let response: Response
    try {
      response = await fetch(this.endpoint.base_url + path, {
        ...init,
        headers,
      })
    } catch (cause) {
      // The service is gone or was never there. Given its own code so callers
      // can treat it exactly like every other failure.
      throw new InfernoError({
        code: "service_unreachable",
        message:
          cause instanceof Error
            ? cause.message
            : "The service did not answer.",
      })
    }

    if (response.status === 204) {
      return null as T
    }

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      const body = (payload as { error?: ServiceErrorBody } | null)?.error
      throw new InfernoError(
        body ?? {
          code: `http_${response.status}`,
          message: response.statusText || "The request failed.",
        },
        response.status
      )
    }

    return payload as T
  }

  health() {
    return this.request<Health>("/health")
  }

  info(url: string, playlist = false) {
    const query = new URLSearchParams({ url, playlist: String(playlist) })

    return this.request<InfoResponse>(`/api/v1/info?${query}`)
  }

  formats(url: string) {
    const query = new URLSearchParams({ url })

    return this.request<{ title: string; formats: unknown[] }>(
      `/api/v1/formats?${query}`
    )
  }

  listJobs(limit = 100) {
    const query = new URLSearchParams({ limit: String(limit) })

    return this.request<{ jobs: Job[]; count: number; total: number }>(
      `/api/v1/downloads?${query}`
    )
  }

  queue(request: DownloadRequest) {
    return this.request<Job>("/api/v1/downloads", {
      method: "POST",
      body: JSON.stringify(request),
    })
  }

  cancel(jobId: string) {
    return this.request<Job>(`/api/v1/downloads/${jobId}/cancel`, {
      method: "POST",
    })
  }

  remove(jobId: string, keepFiles = true) {
    const query = new URLSearchParams({ keep_files: String(keepFiles) })

    return this.request<null>(`/api/v1/downloads/${jobId}?${query}`, {
      method: "DELETE",
    })
  }

  /**
   * The firehose URL for one connection. `since` replays everything missed
   * since that sequence number; the token rides in the query string because a
   * browser cannot set headers on a WebSocket, which is exactly why the service
   * accepts both forms (SPEC §4).
   */
  eventsUrl(since: number | null) {
    const query = new URLSearchParams()
    if (this.endpoint.token) {
      query.set("token", this.endpoint.token)
    }
    if (since !== null) {
      query.set("since", String(since))
    }

    const base = this.endpoint.base_url.replace(/^http/, "ws")

    return `${base}/ws/events?${query}`
  }

  /** Files come from the API, never from reading the download directory. */
  fileUrl(file: ServiceFile) {
    return this.href(file.url)
  }

  /**
   * An absolute, fetchable URL for a path the API handed back.
   *
   * Every `url` in a response is relative, so it stays correct behind a proxy
   * or a different host. This is where it becomes absolute, and the one place
   * the token is appended - in the query string rather than a header, because
   * these URLs are handed to the browser itself (a new tab, a download, an
   * `<img src>`), and none of those can set one.
   */
  href(url: string) {
    if (!this.endpoint.token) {
      return `${this.endpoint.base_url}${url}`
    }

    // The API builds some of these with a query string already.
    const separator = url.includes("?") ? "&" : "?"

    return `${this.endpoint.base_url}${url}${separator}token=${encodeURIComponent(
      this.endpoint.token
    )}`
  }

  /**
   * One directory inside the download folder.
   *
   * The server resolves and bounds the path; an empty string is the root. A
   * browser client has no filesystem of its own, so this is what stands in for
   * "show me where this file is" - see the `/api/v1/files` route for why it
   * exists at all rather than being a desktop-only trick.
   */
  listFiles(path = "") {
    const query = new URLSearchParams({ path })

    return this.request<FileListing>(`/api/v1/files?${query}`)
  }
}

/**
 * What a person should see for a failure, keyed on the service's stable error
 * code. Anything unrecognised falls through to the service's own message,
 * which is always written for a human.
 */
const errorMessages: Record<string, string> = {
  invalid_url: "That does not look like a supported link.",
  unsupported_site: "This site is not supported.",
  video_unavailable: "Private, removed, or blocked in your region.",
  format_unavailable: "That quality is not available for this video.",
  format_mode_conflict: "The app asked for a format that contradicts the mode.",
  po_token_required:
    "YouTube is limiting this download. Sign in via cookies in Settings.",
  // These two used to share one line - "a required component is missing from
  // this installation" - which named neither the component nor anything to do
  // about it. Two unrelated faults looked identical, so the message told you
  // only that something, somewhere, was absent.
  ffmpeg_missing: "ffmpeg is missing, so this file could not be converted.",
  js_runtime_missing:
    "The JavaScript runtime is missing, so this link could not be read.",
  // `postprocessing_failed` and `internal_error` deliberately have no entry:
  // both carry the underlying tool's own words, and those are the only thing
  // that says what actually went wrong. A generic line would throw that away -
  // and an unclassified failure is precisely the case where the raw text is
  // all anyone has to go on.
  network_error: "Connection problem.",
  disk_error: "Could not write the file.",
  job_not_found: "That download is no longer in the queue.",
  setting_locked: "This is managed by your installation.",
  invalid_request: "The app sent an invalid request.",
  unauthorized: "The app lost its connection to the service.",
  service_unreachable: "The download service is not running.",
  not_supported: "That is only available in the desktop app.",
  // `shell_failed` deliberately has no entry: Rust already wrote a specific
  // message ("... is no longer there") and a generic one would lose it.
}

/**
 * The message for an error envelope, wherever it came from - a thrown
 * `InfernoError` or the `error` field stored on a failed job.
 */
export function describeErrorBody(body: ServiceErrorBody): string {
  const base = errorMessages[body.code] ?? body.message
  const detail = body.detail ?? {}

  // `disk_error` names the file it could not write, and a packaging failure
  // lists what was missing - both are the useful half of the message.
  if (body.code === "disk_error" && typeof detail.filename === "string") {
    return `${base} (${detail.filename})`
  }
  if (Array.isArray(detail.reasons) && detail.reasons.length > 0) {
    return `${base} (${detail.reasons.join(", ")})`
  }

  return base
}

export function describeError(error: unknown): string {
  if (error instanceof InfernoError) {
    return describeErrorBody({
      code: error.code,
      message: error.message,
      detail: error.detail,
    })
  }

  return error instanceof Error ? error.message : "Something went wrong."
}

/** Errors a person can act on by changing a setting rather than retrying. */
export function isCookiesError(error: unknown) {
  return error instanceof InfernoError && error.code === "po_token_required"
}
