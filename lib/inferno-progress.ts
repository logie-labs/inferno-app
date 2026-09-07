/**
 * Collapsing a job's raw event stream into the three stages the queue draws.
 *
 * Ported from the service's own reference client (`clients/client.html` and
 * `DownloadProgress` in `clients/cli.py`), which is the authority on this. The
 * service deliberately reports raw values and leaves presentation to the
 * client (SPEC §1), and the raw values are misleading if drawn directly:
 *
 * **The download stage is weighted by stream, not by bytes.** yt-dlp reports
 * progress per stream, so on a video+audio merge percent runs 0->100 twice.
 * Byte-weighting cannot fix it, because the audio stream's size is unknown
 * until it starts and it is a large share of the job - a 15 MB video with
 * 10 MB of audio is ordinary, so learning the total late drags the bar
 * backwards by tens of points. Each expected stream owns an equal slice
 * instead: with a merge, video fills 0-50% and audio 50-100%.
 *
 * **The processing stage counts steps, not time.** ffmpeg reports no
 * percentage through yt-dlp's postprocessor hooks - the hook carries a name and
 * a status and nothing else - so there is no honest way to show a time-based
 * bar. What *is* known is which postprocessors the job resolved to run
 * (`options.postprocessors`) and which of them have reported `finished`. That
 * is a real fraction of real work, so the stage is determinate in steps and
 * only falls back to indeterminate before the first one is known.
 *
 * A high-water mark guards both: neither bar can ever move backwards, whatever
 * the expectations turn out to be.
 */

import type {
  Job,
  JobStatus,
  PostprocessorData,
  ProgressData,
} from "./inferno-service"

export type Stage = "preparing" | "downloading" | "processing" | "done"

export const stageOrder: readonly Stage[] = [
  "preparing",
  "downloading",
  "processing",
]

const stageForStatus: Record<JobStatus, Stage> = {
  queued: "preparing",
  extracting: "preparing",
  downloading: "downloading",
  postprocessing: "processing",
  completed: "done",
  failed: "done",
  cancelled: "done",
}

type StreamKind = "video" | "audio" | "unknown"

type StreamState = {
  kind: StreamKind
  downloaded: number
  total: number
  done: boolean
  /** Per-stream high-water mark, so one bar can never walk backwards. */
  highWater: number
}

/**
 * What kind of stream a progress tick is about.
 *
 * From the codecs, never from arrival order. Which stream yt-dlp fetches first
 * is an implementation detail of the format selector, and guessing it wrong
 * labels the small audio stream "Video" - so the bar named Video fills in a
 * blink and the one named Audio takes the whole download.
 */
function streamKind(data: ProgressData): StreamKind {
  const hasVideo = Boolean(data.vcodec) && data.vcodec !== "none"
  const hasAudio = Boolean(data.acodec) && data.acodec !== "none"

  if (hasVideo) {
    return "video"
  }
  if (hasAudio) {
    return "audio"
  }

  return "unknown"
}

/**
 * Everything derived from a job's events, accumulated across frames. Held
 * per job and mutated in place as frames arrive - the raw `Job` from the API
 * only ever carries the *latest* tick, which is not enough to weight a merge.
 */
export type JobTracker = {
  job: Job
  streams: Map<string, StreamState>
  /** Distinct postprocessors seen, and which have reported `finished`. */
  postprocessorsSeen: Set<string>
  postprocessorsDone: Set<string>
  downloadHighWater: number
  processingHighWater: number
  speed: number | null
  eta: number | null
  note: string
}

export function createTracker(job: Job): JobTracker {
  const tracker: JobTracker = {
    job,
    streams: new Map(),
    postprocessorsSeen: new Set(),
    postprocessorsDone: new Set(),
    downloadHighWater: 0,
    processingHighWater: 0,
    speed: null,
    eta: null,
    note: "waiting for a slot",
  }

  // A job fetched over REST arrives with only its latest tick. Seed from it so
  // a reconnect does not show an empty bar until the next event lands.
  if (job.progress?.format_id) {
    ingestProgress(tracker, job.progress, job.progress.status === "finished")
  }

  return tracker
}

export function stageOf(job: Job): Stage {
  return stageForStatus[job.status] ?? "preparing"
}

/**
 * How many streams to expect. A merging selector means two; the observed count
 * is a floor, so an expectation that turns out wrong widens rather than breaks.
 */
function expectedStreams(tracker: JobTracker) {
  const merging = tracker.job.options?.merging ? 2 : 1

  return Math.max(merging, tracker.streams.size, 1)
}

/**
 * How many postprocessing steps to expect.
 *
 * `options.postprocessors` lists only the ones the *request* resolved to, and
 * under their configured names. yt-dlp runs more than that and reports them
 * under class names, so the two lists do not line up. Measured on a real
 * 360p merge: options said `["FFmpegMetadata", "EmbedThumbnail"]` while the
 * events were `Merger`, `Metadata`, `EmbedThumbnail`, `MoveFiles`.
 *
 * Two of those are predictable rather than guessable: yt-dlp always finishes
 * with `MoveFiles`, and adds `Merger` whenever the format selector merges. So
 * the estimate is the resolved list plus those, and the observed count is a
 * floor underneath it - a denominator that only ever grows, which together
 * with the high-water mark keeps the bar monotonic even when the estimate is
 * wrong.
 */
function expectedPostprocessors(tracker: JobTracker) {
  const resolved = tracker.job.options?.postprocessors?.length ?? 0
  const merger = tracker.job.options?.merging ? 1 : 0
  const moveFiles = 1

  return Math.max(
    resolved + merger + moveFiles,
    tracker.postprocessorsSeen.size,
    1
  )
}

export function ingestProgress(
  tracker: JobTracker,
  data: ProgressData,
  finished: boolean
) {
  const key = data.format_id ?? "?"
  let stream = tracker.streams.get(key)
  if (!stream) {
    stream = {
      kind: streamKind(data),
      downloaded: 0,
      total: 0,
      done: false,
      highWater: 0,
    }
    tracker.streams.set(key, stream)
  } else if (stream.kind === "unknown") {
    // A later tick may carry the codecs an earlier one lacked.
    stream.kind = streamKind(data)
  }

  // Monotonic per stream: a retried fragment must not walk the bar back.
  stream.downloaded = Math.max(stream.downloaded, data.downloaded_bytes ?? 0)
  const total = data.total_bytes ?? data.total_bytes_estimate
  if (total) {
    stream.total = Math.max(stream.total, total)
  }
  if (finished) {
    stream.total = Math.max(stream.total, stream.downloaded)
    stream.done = true
  }

  if (stream.total) {
    stream.highWater = Math.max(
      stream.highWater,
      Math.min((stream.downloaded / stream.total) * 100, 99.9)
    )
  }

  tracker.speed = data.speed ?? null
  tracker.eta = data.eta ?? null
  tracker.note = `stream ${tracker.streams.size}/${expectedStreams(tracker)}`

  refreshDownload(tracker)
}

export function ingestPostprocessor(
  tracker: JobTracker,
  data: PostprocessorData
) {
  const name = data.postprocessor ?? "postprocessor"
  tracker.postprocessorsSeen.add(name)
  if (data.status === "finished") {
    tracker.postprocessorsDone.add(name)
  }
  tracker.note = `${name} ${data.status ?? ""}`.trim()

  refreshProcessing(tracker)
}

function refreshDownload(tracker: JobTracker) {
  if (stageOf(tracker.job) !== "downloading") {
    return
  }

  const streams = [...tracker.streams.values()]
  if (streams.length === 0) {
    return
  }

  const finished = streams.filter((stream) => stream.done).length
  let active = 0
  for (const stream of streams) {
    if (!stream.done && stream.total) {
      active = Math.max(active, stream.downloaded / stream.total)
    }
  }

  const share = ((finished + active) / expectedStreams(tracker)) * 100

  // Never claim 100% while the stage is still running: on a merge the audio
  // stream only appears once the video stream has finished.
  tracker.downloadHighWater = Math.max(
    tracker.downloadHighWater,
    Math.min(share, 99.9)
  )
}

function refreshProcessing(tracker: JobTracker) {
  const share =
    (tracker.postprocessorsDone.size / expectedPostprocessors(tracker)) * 100

  tracker.processingHighWater = Math.max(
    tracker.processingHighWater,
    Math.min(share, 99.9)
  )
}

/**
 * The download stage's percentage, or null while nothing is measurable yet -
 * a stream is running but has reported no total and none has completed, where
 * a determinate 0% would just look stuck.
 */
export function downloadPercent(tracker: JobTracker): number | null {
  const stage = stageOf(tracker.job)
  if (stage === "done") {
    return tracker.job.status === "completed" ? 100 : tracker.downloadHighWater
  }
  if (stage === "processing") {
    return 100
  }
  if (stage !== "downloading") {
    return 0
  }

  const streams = [...tracker.streams.values()]
  if (streams.length === 0) {
    return null
  }
  if (!streams.some((stream) => stream.total || stream.done)) {
    return null
  }

  return tracker.downloadHighWater
}

/**
 * The processing stage's percentage, or null before anything is known about
 * which steps will run.
 */
export function processingPercent(tracker: JobTracker): number | null {
  const stage = stageOf(tracker.job)
  if (stage === "done") {
    return tracker.job.status === "completed"
      ? 100
      : tracker.processingHighWater
  }
  if (stage !== "processing") {
    return 0
  }

  // No resolved list and nothing observed yet: honestly indeterminate.
  const resolved = tracker.job.options?.postprocessors?.length ?? 0
  if (resolved === 0 && tracker.postprocessorsSeen.size === 0) {
    return null
  }

  return tracker.processingHighWater
}

/**
 * The preparing stage is always indeterminate: extraction has no measurable
 * total, so it is a blinker until the download stage takes over.
 */
export function preparingPercent(tracker: JobTracker): number | null {
  return stageOf(tracker.job) === "preparing" ? null : 100
}

/**
 * One bar per thing that actually happens, so each moves at its own honest
 * pace.
 *
 * A merged video download is two separate transfers, and they are nothing like
 * the same size - the audio is routinely a third of the video. Sharing one bar
 * between them (video 0-50%, audio 50-100%) is arithmetically correct and
 * reads as broken: the first half crawls and the second snaps shut. Giving
 * each stream its own segment costs nothing and every segment then means what
 * it looks like.
 *
 * So: audio-only is preparing / audio / processing, and a video merge is
 * preparing / video / audio / processing.
 */
export type Segment = {
  key: string
  label: string
  /** Percentage, or null for a stage with nothing measurable to show yet. */
  value: number | null
  /** Relative width, mirroring the canvas's weighting of the three stages. */
  grow: number
}

/**
 * The download's streams in a fixed order: video first, then audio.
 *
 * Fixed so the bars never swap or resize as they arrive, and derived from the
 * codecs rather than arrival order - see `streamKind`.
 */
function orderedStreams(tracker: JobTracker) {
  const expected = expectedStreams(tracker)
  const found = [...tracker.streams.values()]

  const video = found.filter((stream) => stream.kind === "video")
  const audio = found.filter((stream) => stream.kind === "audio")
  const unknown = found.filter((stream) => stream.kind === "unknown")

  const slots: { label: string; stream: StreamState | null }[] = []

  if (expected > 1) {
    // A merge is one of each; anything unidentified fills the empty slot.
    slots.push({ label: "Video", stream: video[0] ?? unknown[0] ?? null })
    slots.push({
      label: "Audio",
      stream: audio[0] ?? (video[0] ? unknown[0] : unknown[1]) ?? null,
    })
  } else {
    const single = found[0] ?? null
    const label =
      single?.kind === "audio" || tracker.job.options?.mode === "audio"
        ? "Audio"
        : "Video"
    slots.push({ label, stream: single })
  }

  return slots
}

/**
 * How wide each download segment should be. Fixed for the life of the row.
 *
 * Roughly by bytes rather than equally: a YouTube 1080p merge is around 124 MB
 * of video and 10 MB of audio, so two equal bars would make the second snap
 * shut in a blink while the first crawls. Weighting the segments keeps a pixel
 * of bar worth about the same everywhere.
 *
 * These were briefly measured rather than assumed - the true totals were used
 * once both streams had reported their size. That was worse. The audio stream's
 * size is unknown until it starts downloading, so the segment was laid out at
 * the estimate and then resized under the cursor mid-download, which reads as a
 * glitch however smoothly it is transitioned. A width is a layout decision, and
 * layout that moves while you are watching a bar fill is more distracting than
 * a width that is a few percent off. So the split stays put: close enough to
 * the real ratio on every YouTube merge, and never in motion.
 */
const DOWNLOAD_WIDTH = 76
const AUDIO_SHARE = 0.12

function downloadWidths(slots: { stream: StreamState | null }[]): number[] {
  if (slots.length === 1) {
    return [DOWNLOAD_WIDTH]
  }

  return [DOWNLOAD_WIDTH * (1 - AUDIO_SHARE), DOWNLOAD_WIDTH * AUDIO_SHARE]
}

/** The percentage for one stream slot. */
function slotPercent(stream: StreamState | null): number | null {
  if (!stream) {
    // Not started: sits at zero rather than pulsing, because nothing is
    // happening to it yet.
    return 0
  }
  if (stream.done) {
    return 100
  }
  if (!stream.total) {
    // Running but the size is still unknown - honestly indeterminate.
    return null
  }

  return stream.highWater
}

export function segmentsFor(tracker: JobTracker): Segment[] {
  const stage = stageOf(tracker.job)
  const terminal = stage === "done"
  const completed = tracker.job.status === "completed"

  const slots = orderedStreams(tracker)
  const widths = downloadWidths(slots)
  const edge = slots.length > 1 ? 12 : 14

  const preparing: Segment = {
    key: "preparing",
    label: stage === "preparing" ? "Metadata" : "Init",
    value: preparingPercent(tracker),
    grow: edge,
  }

  const streams: Segment[] = slots.map((slot, index) => {
    let value: number | null

    if (completed) {
      value = 100
    } else if (stage === "preparing") {
      value = 0
    } else if (stage === "processing" || terminal) {
      // Past the download: whatever it reached is what it reached.
      value = slotPercent(slot.stream) ?? 100
    } else {
      value = slotPercent(slot.stream)
    }

    return {
      key: `stream-${index}`,
      label: slot.label,
      value,
      grow: widths[index],
    }
  })

  const processing: Segment = {
    key: "processing",
    label: "Cleanup",
    value: processingPercent(tracker),
    grow: edge,
  }

  return [preparing, ...streams, processing]
}

export function totals(tracker: JobTracker) {
  let downloaded = 0
  let total = 0
  for (const stream of tracker.streams.values()) {
    downloaded += stream.downloaded
    total += stream.total
  }

  return { downloaded, total }
}

/** `2 of 4 steps` - what the processing bar is actually counting. */
export function processingSteps(tracker: JobTracker) {
  return {
    done: tracker.postprocessorsDone.size,
    expected: expectedPostprocessors(tracker),
  }
}
