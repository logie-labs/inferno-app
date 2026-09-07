import type { VideoInfo } from "@/lib/inferno-service"

/**
 * What the panel knows about the URL in the bar. Metadata is fetched as soon
 * as a link lands there, so this is one of four states: nothing typed, in
 * flight, resolved, or failed.
 */
export type Preview = {
  loading: boolean
  video: VideoInfo | null
  error: string | null
}

export const emptyPreview: Preview = {
  loading: false,
  video: null,
  error: null,
}

export const loadingPreview: Preview = { ...emptyPreview, loading: true }
