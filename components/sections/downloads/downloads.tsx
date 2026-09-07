"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { describeError, isCookiesError } from "@/lib/inferno-service"

import {
  loadSettingsConfig,
  saveSettingsConfig,
  useSettingsConfig,
  type SettingsConfig,
} from "@/components/sections/settings/settings-config"

import { ConfigurePanel, ConfirmButton } from "./configure-panel"
import { RawFormatsOverlay } from "./detail-overlays"
import { urlPlaceholder } from "./download-data"
import {
  defaultDownloadOptions,
  optionsFromSettings,
  sameSeed,
  recalledOptions,
  rememberOptions,
  parseUrls,
  toDownloadRequest,
  type DownloadOptions,
} from "./download-options"
import { emptyPreview, loadingPreview, type Preview } from "./preview"
import { QueuePanel } from "./queue-panel"
import { useInfernoService } from "./service-context"
import { VideoDetailsDialog } from "./video-details-dialog"

/**
 * How long *typing* has to settle before metadata is fetched. A paste skips it
 * entirely - the URL arrived complete in one event, so there is nothing to wait
 * for and waiting only delays the details by the full interval.
 */
const PREVIEW_DEBOUNCE = 400

/**
 * The Downloads screen from the `Inferno Main.dc.html` canvas: queue on the
 * left, configure panel on the right, URL bar spanning both.
 *
 * Spacing runs on a single 16px gutter - every panel, the queue rows and the
 * URL bar share it, so the input's left edge lines up with the queue card and
 * the confirm button's right edge with the configure panel.
 */
function DownloadsScreen() {
  const { client, connection, health, queue } = useInfernoService()

  const [url, setUrl] = useState("")
  const settings = useSettingsConfig()
  const [options, setOptions] = useState<DownloadOptions>(
    () =>
      recalledOptions() ?? {
        ...defaultDownloadOptions,
        // Settings supplies every starting position it has an opinion
        // about, the Spotify switch included - it is still a per-download
        // decision after that, it just does not start from nowhere.
        ...optionsFromSettings(settings),
      }
  )

  // Settings keeps deciding those defaults, not just the first one: changing
  // one there is a deliberate act, so the panel follows it.
  //
  // Compared by value rather than by identity, and adjusted during render
  // rather than in an effect. By identity, saving any unrelated setting - the
  // download folder, typed one character at a time - would hand back a new
  // object and throw away a choice made in the panel.
  const seed = optionsFromSettings(settings)
  const [lastSeed, setLastSeed] = useState(seed)
  if (!sameSeed(seed, lastSeed)) {
    setLastSeed(seed)
    setOptions((current) => ({ ...current, ...seed }))
  }

  // Remembered for as long as the app is running, so leaving this screen and
  // coming back does not reset the mode and the format.
  useEffect(() => {
    rememberOptions(options)
  }, [options])

  /** Read-modify-write against storage, as the settings screen does. */
  const updateSettings = useCallback(
    (updater: (current: SettingsConfig) => SettingsConfig) => {
      saveSettingsConfig(updater(loadSettingsConfig()))
    },
    []
  )
  // Keyed by the URL it describes, so "which URL is this about" is derived at
  // render rather than kept in sync by an effect that writes state on every
  // keystroke.
  const [resolved, setResolved] = useState<{
    url: string
    preview: Preview
  } | null>(null)
  const [details, setDetails] = useState(false)
  const [expert, setExpert] = useState(false)
  const [queueing, setQueueing] = useState(false)
  /** The URL a paste just produced, which should not wait for the debounce. */
  const immediate = useRef<string | null>(null)

  const urls = parseUrls(url)
  // Metadata is only worth fetching for a single link; a batch paste goes
  // straight to the queue and each job resolves its own title.
  const previewUrl = urls.length === 1 ? urls[0] : null

  // Nothing is written on the synchronous path: an unresolved URL simply
  // renders as loading, and a cleared bar as empty.
  const preview: Preview = !previewUrl
    ? emptyPreview
    : resolved?.url === previewUrl
      ? resolved.preview
      : loadingPreview

  useEffect(() => {
    if (!client || !previewUrl) {
      return
    }

    let live = true

    const fetchInfo = async () => {
      try {
        const info = await client.info(previewUrl)
        if (live) {
          setResolved({
            url: previewUrl,
            preview: {
              loading: false,
              video: info.video,
              // A playlist URL resolves with `video` null and `playlist` set.
              // Downloading one is a per-entry job, which this screen does not
              // model yet, so say so rather than showing an empty panel.
              error: info.video
                ? null
                : info.playlist
                  ? `That link is a playlist (${info.playlist.entries?.length ?? "several"} videos). Paste a single video URL.`
                  : "No video metadata came back for that link.",
            },
          })
        }
      } catch (error) {
        if (live) {
          setResolved({
            url: previewUrl,
            preview: {
              loading: false,
              video: null,
              error: describeError(error),
            },
          })
        }
      }
    }

    // `immediate` is set by the paste handler for exactly the URL it pasted,
    // so a pasted link resolves at once while typing still settles first.
    let timer: ReturnType<typeof setTimeout> | null = null

    if (immediate.current === previewUrl) {
      immediate.current = null
      void fetchInfo()
    } else {
      timer = setTimeout(() => void fetchInfo(), PREVIEW_DEBOUNCE)
    }

    return () => {
      live = false
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [client, previewUrl])

  const confirm = useCallback(async () => {
    if (urls.length === 0) {
      return
    }

    setQueueing(true)
    let queued = 0

    for (const target of urls) {
      try {
        // The switch travels beside the request, not inside it - the
        // service has no idea what Spotify is.
        await queue(
          toDownloadRequest(target, options, settings),
          options.spotify
        )
        queued += 1
      } catch (error) {
        toast.error(describeError(error), {
          description: isCookiesError(error)
            ? "Settings › Privacy › cookies from browser"
            : undefined,
        })
      }
    }

    setQueueing(false)

    if (queued > 0) {
      setUrl("")
      setResolved(null)
    }
  }, [settings, urls, queue, options])

  // A link pasted into the command menu is queued here, because this is where
  // the current options and the service client already are. The mode is the
  // only thing the command overrides - everything else (quality, container,
  // metadata) stays as configured, so the two routes cannot disagree.
  // Same shape as the queue panel's listener, and for the same reason: the
  // options and settings it needs change often, so they are read from a ref
  // and the subscription itself is made once.
  const queueContext = useRef({ queue, options, settings })
  useEffect(() => {
    queueContext.current = { queue, options, settings }
  })

  useEffect(() => {
    function onQueueUrl(event: Event) {
      const detail = (
        event as CustomEvent<{
          url: string
          mode: string
          /** Set by callers that configure the download themselves. */
          options?: Partial<DownloadOptions>
        }>
      ).detail
      if (!detail?.url) {
        return
      }

      event.preventDefault()

      const mode = detail.mode === "audio" ? "audio" : "video"
      const current = queueContext.current
      // The panel's options are the starting point either way; a caller that
      // knows what it wants - the command menu's "Add to Spotify" - says so on
      // top rather than reaching in and changing the panel first.
      const overrides = detail.options ?? {}
      void current
        .queue(
          toDownloadRequest(
            detail.url,
            { ...current.options, mode, ...overrides },
            current.settings
          ),
          mode === "audio" && (overrides.spotify ?? current.options.spotify),
          overrides.askWhereToSave ?? current.options.askWhereToSave
        )
        .catch((error) => toast.error(describeError(error)))
    }

    window.addEventListener("inferno-app:queue-url", onQueueUrl)

    return () => {
      window.removeEventListener("inferno-app:queue-url", onQueueUrl)
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize="65%" minSize="40%">
            <QueuePanel />
          </ResizablePanel>

          <ResizableHandle />

          {/* 384px in the canvas; draggable so the queue can be widened. */}
          <ResizablePanel defaultSize="35%" minSize="320px" maxSize="50%">
            <ConfigurePanel
              options={options}
              onOptionsChange={setOptions}
              onOpenDetails={() => setDetails(true)}
              onOpenExpert={() => setExpert(true)}
              preview={preview}
              // The setting as stored, so this field and the Settings
              // screen's are the same field. The service's own folder goes
              // alongside as the placeholder rather than being folded into
              // the value.
              downloadDirectory={settings.downloads.location}
              serviceDirectory={health?.download_dir ?? null}
              // Saved straight into settings, which is the same value the
              // Settings screen edits - two views of one setting, not two
              // settings that have to be kept in step.
              onChangeDirectory={(location) =>
                updateSettings((current) => ({
                  ...current,
                  downloads: { ...current.downloads, location },
                }))
              }
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {expert ? (
          <RawFormatsOverlay
            formats={preview.video?.formats ?? []}
            selected={options.formatId}
            onSelect={(formatId) => {
              setOptions((current) => ({ ...current, formatId }))
              setExpert(false)
            }}
            onClose={() => setExpert(false)}
          />
        ) : null}
      </div>

      <footer className="shrink-0 border-t">
        <div className="flex items-center gap-4 p-4">
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onPaste={(event) => {
              const pasted = parseUrls(event.clipboardData.getData("text"))
              // Only a single link has details worth showing; a batch goes
              // straight to the queue.
              immediate.current = pasted.length === 1 ? pasted[0] : null
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void confirm()
              }
            }}
            placeholder={urlPlaceholder}
            aria-label="Download URL"
            spellCheck={false}
            className="h-11 flex-1 bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)] px-4 font-mono text-xs tracking-[0.02em] md:text-xs"
          />
          <ConfirmButton
            mode={options.mode}
            busy={queueing}
            disabled={urls.length === 0 || connection !== "ready"}
            onClick={() => void confirm()}
          />
        </div>
      </footer>

      <VideoDetailsDialog
        video={preview.video}
        open={details}
        onOpenChange={setDetails}
      />
    </div>
  )
}

// The provider now lives at the app root - see `app/layout.tsx`. Wrapping the
// screen here meant switching to Settings tore down the socket, the job
// trackers, the library and the health report, and coming back rebuilt all of
// it from nothing. Downloads are supposed to carry on while you look at
// something else.
export default function DownloadsSection() {
  return <DownloadsScreen />
}
