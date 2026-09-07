/**
 * Turning a normalised video into the things the UI actually shows.
 *
 * The service reports raw values and leaves presentation to the client
 * (SPEC §1), and every field is optional - an extractor that is not YouTube
 * may report no view count, no chapters and no captions at all. So everything
 * here returns `null` rather than a zero or a placeholder, and the views drop
 * a row instead of printing "0 views" for something that was never counted.
 */

import type {
  SubtitleTracks,
  VideoFormat,
  VideoInfo,
} from "@/lib/inferno-service"

/** `"2026-03-12"` -> `"12 Mar 2026"`. Left alone if it is not a date. */
export function formatUploadDate(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** The biggest stream on each side, which is what "best" means to a person. */
function largest(formats: VideoFormat[], pick: (f: VideoFormat) => boolean) {
  const candidates = formats.filter(pick)
  if (candidates.length === 0) {
    return null
  }

  return candidates.reduce((best, format) => {
    const size = format.filesize ?? format.filesize_approx ?? 0
    const bestSize = best.filesize ?? best.filesize_approx ?? 0

    return size > bestSize ? format : best
  })
}

function hasVideo(format: VideoFormat) {
  return format.has_video ?? format.vcodec !== "none"
}

function hasAudio(format: VideoFormat) {
  return format.has_audio ?? format.acodec !== "none"
}

export function describeFormat(format: VideoFormat | null) {
  if (!format) {
    return null
  }

  const parts = [
    format.resolution,
    format.vcodec && format.vcodec !== "none" ? format.vcodec : null,
    format.fps ? `${Math.round(format.fps)}fps` : null,
    !hasVideo(format) && format.acodec !== "none" ? format.acodec : null,
    !hasVideo(format) && format.abr ? `${Math.round(format.abr)}k` : null,
  ].filter(Boolean)

  return {
    id: format.format_id,
    spec: parts.join(" ") || format.ext || format.format_id,
    bytes: format.filesize ?? format.filesize_approx ?? null,
  }
}

/** Language codes with real tracks, and how many are machine generated. */
function languages(tracks: SubtitleTracks | undefined) {
  return Object.entries(tracks ?? {})
    .filter(([, entries]) => entries.length > 0)
    .map(([code]) => code)
}

export type VideoFacts = ReturnType<typeof videoFacts>

export function videoFacts(video: VideoInfo) {
  const formats = video.formats ?? []
  const videoFormats = formats.filter(hasVideo)
  const audioFormats = formats.filter(
    (format) => hasAudio(format) && !hasVideo(format)
  )

  const subtitles = languages(video.subtitles)
  const automatic = languages(video.automatic_captions)

  return {
    title: video.title ?? null,
    description: video.description ?? null,
    thumbnail: video.thumbnail ?? null,
    channel: video.channel ?? video.uploader ?? null,
    channelUrl: video.channel_url ?? null,
    subscribers: video.channel_follower_count ?? null,
    duration: video.duration ?? null,
    published: formatUploadDate(video.upload_date),
    views: video.view_count ?? null,
    likes: video.like_count ?? null,
    comments: video.comment_count ?? null,
    chapters: video.chapters?.length ?? null,
    subtitles,
    automatic,
    videoId: video.id ?? null,
    url: video.webpage_url ?? video.original_url ?? null,
    availability: video.availability ?? null,
    licence: video.license ?? null,
    ageLimit: video.age_limit ?? null,
    live: Boolean(video.is_live),
    wasLive: Boolean(video.was_live),
    source: video.extractor_key ?? null,
    formats: {
      total: formats.length,
      video: videoFormats.length,
      audio: audioFormats.length,
    },
    bestVideo: describeFormat(largest(formats, hasVideo)),
    bestAudio: describeFormat(
      largest(formats, (format) => hasAudio(format) && !hasVideo(format))
    ),
  }
}

/** `public` -> `Public`, `needs_auth` -> `Needs auth`. */
export function humanise(value: string | null) {
  if (!value) {
    return null
  }

  const spaced = value.replace(/[_-]+/g, " ")

  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Languages the app's own runtime cannot name.
 *
 * `Intl.DisplayNames` is only as good as the ICU data it is compiled against,
 * and the WebView the desktop app runs in ships a smaller set than Node does -
 * so these all resolve when the code is tested and none of them resolve where
 * it actually runs. YouTube offers auto-captions in every one of them, and a
 * list reading "aa / aa / auto" is no use to anyone.
 *
 * The names are CLDR's own, taken from a full ICU build rather than written by
 * hand, so they match what `Intl` returns wherever it does work.
 */
const EXTRA_LANGUAGE_NAMES: Record<string, string> = {
  aa: "Afar",
  ab: "Abkhazian",
  ba: "Bashkir",
  bo: "Tibetan",
  crs: "Seselwa Creole French",
  dz: "Dzongkha",
  fj: "Fijian",
  gaa: "Ga",
  gv: "Manx",
  kha: "Khasi",
  kl: "Kalaallisut",
  lua: "Luba-Lulua",
  luo: "Luo",
  mfe: "Morisyen",
  new: "Newari",
  os: "Ossetic",
  pam: "Pampanga",
  rn: "Rundi",
  sg: "Sango",
  ss: "Swati",
  tum: "Tumbuka",
  ve: "Venda",
  war: "Waray",
}

/**
 * `en`, `en-GB` -> a display name.
 *
 * `Intl` is asked first, since it knows far more than any table here could and
 * localises properly. It signals failure by handing the code straight back,
 * which is the case the table above exists to catch.
 */
export function languageName(code: string) {
  let named: string | undefined

  try {
    named = new Intl.DisplayNames(["en"], { type: "language" }).of(code)
  } catch {
    named = undefined
  }

  // Unchanged means it did not recognise it, not that the name is the code.
  if (named && named !== code) {
    return named
  }

  return EXTRA_LANGUAGE_NAMES[code.toLowerCase()] ?? code
}
