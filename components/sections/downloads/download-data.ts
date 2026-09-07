/**
 * The last of the Claude Design canvas (`Inferno Main.dc.html`) fixtures.
 *
 * The queue, the configure panel and the raw format table are now driven by
 * `inferno-service`; what remains here is the copy that has no backend
 * (`urlPlaceholder`, `dropHint`) and the video-details fixtures, which the
 * details dialog still reads. That dialog is deliberately not wired yet - its
 * entry point in the configure panel stays disabled so this data is never
 * presented as a real video's.
 */

/**
 * Structured so the dialog can format it: raw numbers go through
 * `lib/format.ts`, language codes drive the flag icons. The values are the
 * canvas ones; likes and comments are new, since the design listed neither
 * but the stat strip shows them.
 */
export const videoInfo = {
  channel: { name: "Signal Path", subscribers: 214000 },
  durationSeconds: 2538,
  published: "12 Mar 2026",
  views: 184902,
  likes: 9241,
  comments: 1032,
  videoId: "kQ7pM2xvT9A",
  url: "youtube.com/watch?v=kQ7pM2xvT9A",
  availability: "Public · no age gate",
  chapters: 9,
  subtitles: [
    { code: "GB", label: "English" },
    { code: "DE", label: "German" },
  ],
  autoSubtitleLanguages: 12,
  bestVideo: { id: "313", spec: "3840x2160 vp9 60fps", bytes: 2254857830 },
  bestAudio: { id: "251", spec: "opus 160k", bytes: 123731968 },
  formats: { total: 24, video: 18, audio: 6 },
  live: false,
  licence: "Standard YouTube licence",
}

export type VideoInfo = typeof videoInfo

export const selectedTitle = "Modular synth patch walkthrough — full session"

export const selectedDescription =
  "A single-take patch built from scratch on a small Eurorack case, with notes on gain staging and the sequencer setup used throughout."

export const urlPlaceholder =
  "YouTube video URL…   paste several at once, separated by spaces or new lines"

export const dropHint = "drop links anywhere in this window to queue them"
