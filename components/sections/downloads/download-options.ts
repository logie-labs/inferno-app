/**
 * What the configure panel collects, and how it becomes a `DownloadRequest`.
 *
 * The request carries **intent**, never yt-dlp internals (SPEC §7): a quality
 * and a container, not a format selector. Anything the panel does not send is
 * inherited from the user's download defaults on the service, so a field left
 * alone stays under their control rather than being pinned by the app.
 */

import type { DownloadRequest } from "@/lib/inferno-service"
import { toServiceTemplate } from "@/lib/filename-template"

import type { SettingsConfig } from "@/components/sections/settings/settings-config"

export type ConfigureMode = "video" | "audio"

/** `None` and `Chapters + thumbnail` in the panel, `embed_*` on the wire. */
export type MetadataChoice = "all" | "thumbnail" | "tags" | "none"

export type SubtitleChoice = "none" | "en" | "en-auto" | "all"

export type DownloadOptions = {
  mode: ConfigureMode
  /** Video mode. `best` lets the service pick the highest on offer. */
  quality: string
  container: string
  /** Audio mode. `keep` leaves the downloaded stream untouched. */
  audioFormat: string
  audioQuality: number
  subtitles: SubtitleChoice
  metadata: MetadataChoice
  /** Set from the raw format table; bypasses quality and container. */
  formatId: string | null
  /**
   * Ask where this one goes once it has finished.
   *
   * Per download as well as a setting, for the same reason the Spotify switch
   * is: "put this one somewhere else" is a thought people have about one file,
   * not a mode they want to live in.
   */
  askWhereToSave: boolean
  /**
   * Also deliver this one into Spotify's local files.
   *
   * Per download rather than only a setting: whether a particular track
   * belongs in a music library is a decision about that track. The setting
   * supplies the default, and the switch is only offered when the chosen
   * format is one Spotify can actually play.
   */
  spotify: boolean
}

export const defaultDownloadOptions: DownloadOptions = {
  mode: "video",
  quality: "1080p",
  container: "mp4",
  audioFormat: "m4a",
  audioQuality: 192,
  subtitles: "none",
  metadata: "all",
  formatId: null,
  askWhereToSave: false,
  spotify: false,
}

const embedsFor: Record<
  MetadataChoice,
  { embed_thumbnail: boolean; embed_metadata: boolean }
> = {
  all: { embed_thumbnail: true, embed_metadata: true },
  thumbnail: { embed_thumbnail: true, embed_metadata: false },
  tags: { embed_thumbnail: false, embed_metadata: true },
  none: { embed_thumbnail: false, embed_metadata: false },
}

const subtitleLanguages: Record<SubtitleChoice, string[]> = {
  none: [],
  en: ["en"],
  "en-auto": ["en"],
  all: ["all"],
}

/**
 * The app's rate limit is kilobytes per second, decimal.
 *
 * The service takes bytes per second, and "Kbps" in the settings type was
 * ambiguous by 8x. The settings screen has always rendered the value as
 * `value / 1000` **MB/s** - bytes, not bits - so decimal kilobytes is the
 * reading that keeps every number already on screen meaning what it says. The
 * field is named `rateLimitKBps` so it cannot drift back into ambiguity.
 */
export function toRateLimitBytes(rateLimitKBps: number): number | undefined {
  return rateLimitKBps > 0 ? rateLimitKBps * 1000 : undefined
}

/**
 * Build the request. Only fields the user actually chose are sent; everything
 * else is left out so the service's own download defaults apply.
 */
export function toDownloadRequest(
  url: string,
  options: DownloadOptions,
  settings: SettingsConfig
): DownloadRequest {
  const embeds = embedsFor[options.metadata]

  const request: DownloadRequest = {
    url,
    mode: options.mode,
    playlist: false,
    embed_thumbnail: embeds.embed_thumbnail,
    embed_metadata: embeds.embed_metadata,
  }

  if (options.formatId) {
    // The escape hatch wins over quality and container, and the service
    // rejects a merged id in audio mode rather than guessing.
    request.format_id = options.formatId
  } else if (options.mode === "video") {
    request.quality = options.quality
    if (options.container) {
      request.container = options.container
    }
  }

  if (options.mode === "audio" && options.audioFormat !== "keep") {
    request.audio_format = options.audioFormat
    request.audio_quality = options.audioQuality
  }

  if (options.mode === "video" && options.subtitles !== "none") {
    request.subtitles = subtitleLanguages[options.subtitles]
    request.auto_subtitles = options.subtitles === "en-auto"
    request.embed_subtitles = true
  }

  // App-level settings that map onto a per-job field. The service's own
  // settings cover the rest; passing them here would only override the user.
  const rateLimit = toRateLimitBytes(settings.network.rateLimitKBps)
  if (rateLimit) {
    request.rate_limit = rateLimit
  }
  if (settings.downloads.filenameTemplate) {
    // Compiled to yt-dlp's own `%(field)s` syntax rather than left as friendly
    // braces. The service passes a template containing `%(` straight through,
    // and that is the only way to reach field formatting like a readable
    // upload date. The extension is appended there and only there.
    request.output_template = toServiceTemplate(
      settings.downloads.filenameTemplate
    )
  }
  // yt-dlp has no case conversion, so the service applies this when it moves
  // the finished file into the download folder.
  if (settings.downloads.filenameCase !== "original") {
    request.filename_case = settings.downloads.filenameCase
  }

  return request
}

/** Splits a pasted blob into URLs. Several at once, per the placeholder text. */
export function parseUrls(input: string): string[] {
  return input
    .split(/[\s\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

// --- the panel's catalogue ---------------------------------------------------
//
// Every choice here maps onto a real `DownloadRequest` field. The canvas also
// drew a "Video codec" and an audio "Bitrate mode" dropdown; the service takes
// intent rather than yt-dlp internals and exposes neither, so rather than ship
// two controls that cannot do anything they are left out until the API grows a
// field for them.

export type OptionChoice = {
  value: string
  label: string
  desc?: string
  recommended?: boolean
}

export type OptionGroup = {
  key:
    | "quality"
    | "container"
    | "audioQuality"
    | "audioFormat"
    | "subtitles"
    | "metadata"
  label: string
  allLabel: string
  /** Values shown above the rule, in this order. */
  pinned: string[]
  choices: OptionChoice[]
  /**
   * Which values mean off and on, for a group shown as a switch.
   *
   * Present only where the group is genuinely a yes/no with detail behind it.
   * Resolution has no "off", so it has no toggle and stays a plain dropdown.
   */
  toggle?: { off: string; on: string }
}

const qualityGroup: OptionGroup = {
  key: "quality",
  label: "Resolution",
  allLabel: "All resolutions",
  pinned: ["best", "1080p", "720p"],
  choices: [
    {
      value: "best",
      label: "Best available",
      desc: "Highest the video offers",
      recommended: true,
    },
    { value: "2160p", label: "2160p", desc: "4K · very large files" },
    { value: "1440p", label: "1440p", desc: "2K" },
    { value: "1080p", label: "1080p", desc: "Safe default for any player" },
    { value: "720p", label: "720p", desc: "Small and fast" },
    { value: "480p", label: "480p" },
    { value: "360p", label: "360p" },
    { value: "240p", label: "240p" },
    { value: "144p", label: "144p" },
  ],
}

const containerGroup: OptionGroup = {
  key: "container",
  label: "Container",
  allLabel: "All containers",
  pinned: ["mp4", "mkv", "webm"],
  choices: [
    { value: "mp4", label: "MP4", desc: "Works everywhere", recommended: true },
    { value: "mkv", label: "MKV", desc: "Any codec, no re-encode" },
    { value: "webm", label: "WebM", desc: "Smallest files" },
    { value: "mov", label: "MOV", desc: "Apple editing workflows" },
    { value: "avi", label: "AVI", desc: "Legacy players only" },
    { value: "flv", label: "FLV", desc: "Legacy streaming" },
  ],
}

const audioQualityGroup: OptionGroup = {
  key: "audioQuality",
  label: "Quality",
  allLabel: "All bitrates",
  pinned: ["320", "192", "128"],
  choices: [
    {
      value: "320",
      label: "320 kbps",
      desc: "Highest the service accepts",
      recommended: true,
    },
    { value: "256", label: "256 kbps" },
    { value: "192", label: "192 kbps", desc: "Good size / quality balance" },
    { value: "128", label: "128 kbps" },
    { value: "96", label: "96 kbps", desc: "Speech only" },
  ],
}

const audioFormatGroup: OptionGroup = {
  key: "audioFormat",
  label: "Format",
  allLabel: "All formats",
  pinned: ["m4a", "mp3", "keep"],
  choices: [
    {
      value: "m4a",
      label: "M4A",
      desc: "YouTube native — no re-encode",
      recommended: true,
    },
    { value: "mp3", label: "MP3", desc: "Plays on anything" },
    {
      value: "keep",
      label: "Keep original",
      desc: "Exact stream, no re-encode",
    },
    { value: "opus", label: "Opus", desc: "Best quality per byte" },
    { value: "aac", label: "AAC", desc: "Re-encoded from source" },
    { value: "flac", label: "FLAC", desc: "Lossless container, larger" },
    { value: "alac", label: "ALAC", desc: "Apple lossless" },
    { value: "vorbis", label: "Vorbis", desc: "Ogg container" },
    { value: "wav", label: "WAV", desc: "Uncompressed, huge" },
  ],
}

const subtitlesGroup: OptionGroup = {
  key: "subtitles",
  label: "Subtitles",
  allLabel: "All subtitle options",
  pinned: ["none", "en"],
  // On means the uploader's own English captions - the useful default. Auto
  // and every language are a step past that, for whoever wants them.
  toggle: { off: "none", on: "en" },
  choices: [
    { value: "none", label: "None", recommended: true },
    { value: "en", label: "English", desc: "Uploader captions if present" },
    { value: "en-auto", label: "English (auto)", desc: "Machine generated" },
    { value: "all", label: "All available", desc: "Every offered language" },
  ],
}

const metadataGroup: OptionGroup = {
  key: "metadata",
  label: "Metadata",
  allLabel: "All metadata options",
  pinned: ["all", "none"],
  toggle: { off: "none", on: "all" },
  choices: [
    {
      value: "all",
      label: "Chapters + thumbnail",
      desc: "Embedded where supported",
      recommended: true,
    },
    { value: "thumbnail", label: "Thumbnail only" },
    { value: "tags", label: "Tags only" },
    { value: "none", label: "None" },
  ],
}

/**
 * The audio lists, for the places outside the panel that have to offer them.
 *
 * Exported rather than copied: a format added here should appear wherever a
 * format is chosen, and a second list is a second thing to forget.
 */
export const audioFormatChoices = audioFormatGroup.choices
export const audioBitrateChoices = audioQualityGroup.choices

export const optionGroups: Record<
  ConfigureMode,
  { primary: OptionGroup[]; toggles: OptionGroup[] }
> = {
  video: {
    primary: [qualityGroup, containerGroup],
    toggles: [subtitlesGroup, metadataGroup],
  },
  audio: {
    primary: [audioQualityGroup, audioFormatGroup],
    toggles: [metadataGroup],
  },
}

/**
 * The part of the panel's options that Settings has an opinion about.
 *
 * Deliberately not all of them: the mode and the raw format id are decisions
 * about one download, not defaults to be restored.
 *
 * The Spotify switch *is* here, despite being a per-download decision, because
 * "Switch on by default" is a setting whose entire job is to place it. Left
 * out, it only landed on the very first run and every later change to it did
 * nothing at all.
 */
export type SettingsSeed = Pick<
  DownloadOptions,
  | "quality"
  | "container"
  | "audioFormat"
  | "audioQuality"
  | "subtitles"
  | "metadata"
  | "spotify"
  | "askWhereToSave"
>

/**
 * A stored value, but only if the group still offers it.
 *
 * Settings and the panel keep their own lists, and they do drift - a bitrate
 * typed into settings need not be one of the offered steps. Falling back
 * beats seeding the panel with a value its dropdown cannot display.
 */
function choiceOr(group: OptionGroup, value: string, fallback: string) {
  return group.choices.some((choice) => choice.value === value)
    ? value
    : fallback
}

/**
 * What a settings config means in the configure panel.
 *
 * The single place that knows how a stored default becomes a panel option, so
 * adding a setting later is a line here rather than a hunt through the panel.
 */
export function optionsFromSettings(config: SettingsConfig): SettingsSeed {
  const { audio, video } = config

  // Two booleans in settings, four choices in the panel - the panel's list is
  // the finer of the two, so every combination has somewhere to land.
  const metadata: MetadataChoice =
    audio.embedMetadata && audio.embedThumbnail
      ? "all"
      : audio.embedThumbnail
        ? "thumbnail"
        : audio.embedMetadata
          ? "tags"
          : "none"

  return {
    quality: choiceOr(
      qualityGroup,
      video.quality,
      defaultDownloadOptions.quality
    ),
    container: choiceOr(
      containerGroup,
      video.container,
      defaultDownloadOptions.container
    ),
    audioFormat: choiceOr(
      audioFormatGroup,
      audio.format,
      defaultDownloadOptions.audioFormat
    ),
    audioQuality: Number(
      choiceOr(
        audioQualityGroup,
        String(audio.bitrateKbps),
        String(defaultDownloadOptions.audioQuality)
      )
    ),
    // The setting is a yes/no, and the panel's switch is the same yes/no -
    // which language it lands on is the toggle's business.
    subtitles: video.embedSubtitles ? "en" : "none",
    metadata,
    spotify: config.spotify.defaultOn,
    askWhereToSave: config.downloads.askWhereToSave,
  }
}

/** Whether two seeds say the same thing, which is not the same as being the same object. */
export function sameSeed(a: SettingsSeed, b: SettingsSeed) {
  return (Object.keys(a) as (keyof SettingsSeed)[]).every(
    (key) => a[key] === b[key]
  )
}

/** The current value of one group, as a string for comparison against choices. */
export function valueOf(options: DownloadOptions, key: OptionGroup["key"]) {
  switch (key) {
    case "quality":
      return options.quality
    case "container":
      return options.container
    case "audioQuality":
      return String(options.audioQuality)
    case "audioFormat":
      return options.audioFormat
    case "subtitles":
      return options.subtitles
    case "metadata":
      return options.metadata
  }
}

export function withValue(
  options: DownloadOptions,
  key: OptionGroup["key"],
  value: string
): DownloadOptions {
  switch (key) {
    case "quality":
      // A quality or container choice retires the raw-format escape hatch,
      // which would otherwise silently win over both.
      return { ...options, quality: value, formatId: null }
    case "container":
      return { ...options, container: value, formatId: null }
    case "audioQuality":
      return { ...options, audioQuality: Number(value) }
    case "audioFormat":
      return { ...options, audioFormat: value }
    case "subtitles":
      return { ...options, subtitles: value as SubtitleChoice }
    case "metadata":
      return { ...options, metadata: value as MetadataChoice }
  }
}

/** The label to show on a collapsed dropdown. */
export function labelFor(group: OptionGroup, value: string) {
  return group.choices.find((choice) => choice.value === value)?.label ?? value
}

/**
 * What the configure panel was last set to, for this run of the app.
 *
 * A module-level value rather than storage: switching to Settings and back
 * unmounts the whole downloads screen, so without this the panel resets - and
 * re-picking "Audio" every time you glance at another page is the kind of
 * friction that makes a tool feel forgetful. Deliberately *not* persisted, so
 * a fresh launch starts from the documented defaults rather than from whatever
 * one-off you were doing last week.
 *
 * The whole shape is kept, not only the mode: quality and format reset just as
 * annoyingly, and remembering half of it would be stranger than either.
 */
let sessionOptions: DownloadOptions | null = null

export function rememberOptions(options: DownloadOptions) {
  sessionOptions = options
}

export function recalledOptions(): DownloadOptions | null {
  return sessionOptions
}
