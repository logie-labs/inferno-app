"use client"

import { useEffect, useRef, useState } from "react"
import {
  RiCloseCircleLine,
  RiDeleteBinLine,
  RiEraserLine,
  RiFileCopyLine,
  RiFileSearchLine,
  RiDownload2Line,
  RiExternalLinkLine,
  RiFolderOpenLine,
  RiInformationLine,
  RiLinkM,
  RiPlayCircleLine,
  RiRefreshLine,
  RiSpotifyLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useSettingsConfig } from "@/components/sections/settings/settings-config"
import { formatBytes } from "@/lib/format"
import {
  primaryFile,
  verifyEntry,
  type LibraryEntry,
} from "@/lib/inferno-library"
import { deliverToFolders, isSpotifyCompatible } from "@/lib/spotify"
import {
  processingPercent,
  processingSteps,
  segmentsFor,
  stageOf,
  totals,
  type JobTracker,
} from "@/lib/inferno-progress"
import { capabilities } from "@/lib/deployment"
import { downloadFile, openFile, relativeToRoot } from "@/lib/file-actions"
import {
  describeError,
  describeErrorBody,
  openPath,
  openUrl,
  revealPath,
  terminalStatuses,
  type VideoInfo,
} from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import { dropHint } from "./download-data"
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog"
import { LibraryRow } from "./library-row"
import { RowContextMenu, RowMenu, type RowAction } from "./row-menu"
import { Thumbnail } from "./thumbnail"
import { VideoDetailsDialog } from "./video-details-dialog"
import { LocateFileDialog } from "./locate-file-dialog"
import { RuleButton } from "./rule-button"
import { useFileBrowser } from "./file-browser-dialog"
import { useInfernoService } from "./service-context"

/**
 * One of the three progress segments.
 *
 * `value` is a percentage, or null for a stage that genuinely has no
 * measurable total - which pulses instead of drawing a fake number. Preparing
 * is always indeterminate; downloading and processing are indeterminate only
 * before their first measurable event.
 */
function StageSegment({
  value,
  grow,
  fill,
}: {
  value: number | null
  grow: number
  fill: string
}) {
  const indeterminate = value === null

  return (
    <Progress
      value={indeterminate ? 100 : value}
      // `grow` is fixed for the life of the row, so there is nothing to
      // animate here - the segment is laid out once and only its fill moves.
      style={{ flex: `${grow} 1 0` }}
      className={cn(
        "gap-0",
        // Base UI nests Root > Track > Indicator, so neither the bar nor its
        // fill is the element these classes land on - the height and colours
        // have to be aimed at the slots. Styling the root's direct child would
        // hit the track, which is what left the fill on its default
        // `bg-primary` (red here) instead of white.
        "[&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:rounded-none",
        "[&_[data-slot=progress-track]]:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)]",
        fill,
        indeterminate && "inferno-pulse"
      )}
    />
  )
}

/** `MP4 1080p · 318 MB` - what the row shows beside the title. */
function metaFor(tracker: JobTracker) {
  const options = tracker.job.options ?? {}
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

  const { total, downloaded } = totals(tracker)
  const size = total || downloaded
  const head = parts.join(" ")
  const tail = size ? formatBytes(size) : ""

  return [head, tail].filter(Boolean).join(" · ")
}

/** The middle label: what is happening, in the words for this exact stage. */
function detailFor(tracker: JobTracker) {
  const { job } = tracker

  if (job.status === "failed") {
    return job.error ? describeErrorBody(job.error) : "Failed"
  }
  if (job.status === "cancelled") {
    return "Cancelled"
  }

  const { downloaded, total } = totals(tracker)

  if (job.status === "completed") {
    return total ? `Saved · ${formatBytes(total)}` : "Saved"
  }

  const stage = stageOf(job)

  if (stage === "downloading") {
    const size = total
      ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
      : formatBytes(downloaded)
    const rate = tracker.speed ? ` · ${formatBytes(tracker.speed)}/s` : ""
    const eta =
      tracker.eta !== null && tracker.eta !== undefined
        ? ` · ${tracker.eta}s left`
        : ""
    // Which of the two transfers this is, when there are two.
    const streams = segmentsFor(tracker).filter((segment) =>
      segment.key.startsWith("stream-")
    )
    const active = streams.findIndex((segment) => (segment.value ?? 0) < 100)
    const which =
      streams.length > 1 && active >= 0 ? `${streams[active].label} · ` : ""

    return `${which}${size}${rate}${eta}`
  }

  if (stage === "processing") {
    const steps = processingSteps(tracker)

    return `${tracker.note || "Processing"} · step ${Math.min(steps.done + 1, steps.expected)} of ${steps.expected}`
  }

  return job.status === "extracting" ? "Reading metadata" : "Waiting for a slot"
}

function QueueRowItem({
  tracker,
  onLocate,
  onShowDetails,
  onConfirm,
}: {
  tracker: JobTracker
  onLocate: (entry: LibraryEntry) => void
  onShowDetails: (video: VideoInfo) => void
  onConfirm: (request: ConfirmRequest) => void
}) {
  const { cancel, remove, retry, entryFor, destroy, client, health } =
    useInfernoService()
  const fileBrowser = useFileBrowser()
  const { job } = tracker

  const failed = job.status === "failed" || job.status === "cancelled"
  const done = job.status === "completed"
  const active = !terminalStatuses.includes(job.status)
  const stage = stageOf(job)

  // The fill is the indicator slot; Base UI already transitions its width.
  const fill = failed
    ? "[&_[data-slot=progress-indicator]]:bg-destructive/70"
    : "[&_[data-slot=progress-indicator]]:bg-foreground"

  const lit = (on: boolean) => (on ? "text-foreground" : "text-foreground/35")

  const title = job.video?.title ?? job.url ?? "Queued download"
  const detail = detailFor(tracker)

  // A failed job leaves its bars stalled where they got to rather than
  // pulsing forever - the work is not still happening.
  const segments = segmentsFor(tracker)
  const processing = failed
    ? tracker.processingHighWater
    : processingPercent(tracker)

  // The primary artefact: the media file, not a thumbnail or a subtitle
  // sidecar that happened to sort first.
  const primary = primaryFile(job)
  const entry = entryFor(job.job_id)
  // The library knows where the file is *now*; the job only knows where it was
  // put. Prefer the library once it has a record, so a relocated file opens
  // from its new home.
  const location = entry?.file_path ?? primary?.path ?? job.directory ?? null
  /**
   * The file the row points at is not there any more.
   *
   * Two sources, because the two products learn it differently. The desktop
   * has the library, which stats the path and records the answer. A browser
   * cannot stat anything, so the service reports `exists` per file as it
   * lists a job - without it the container offered Open and Download for a
   * file deleted from the server, and only the click found out.
   *
   * `=== false` rather than falsiness: a service too old to report the field
   * leaves it undefined, which is not the same claim as "gone".
   */
  const missing = entry?.state === "missing" || primary?.exists === false

  /**
   * Re-check the file before acting on it, rather than polling. Opening this
   * menu is the moment the answer starts to matter, and the check is an
   * existence test - no hashing, no directory walk.
   */
  const checkThenRun = async (run: () => void) => {
    if (!entry) {
      run()

      return
    }

    const current = await verifyEntry(entry.id).catch(() => null)
    if (current?.state === "missing") {
      onLocate(current)

      return
    }
    run()
  }

  /**
   * Delete everything this download produced.
   *
   * Both halves matter. The service knows every file the job wrote - the media
   * and its sidecars - so it clears those; the library knows where the file is
   * *now*, which is somewhere else entirely if it has been relocated. Doing
   * only one of the two leaves something behind.
   */
  const deleteDownload = async () => {
    try {
      if (entry) {
        await destroy(entry)
      }
      await remove(job.job_id, false)
      toast.success("Deleted", {
        description: `${primary?.name ?? "The download"} was deleted from disk.`,
      })
    } catch (error) {
      reportFailure(error)
    }
  }

  // Prefer the library's copy of the metadata: it is the full object as
  // recorded, and it outlives the job, which the service drops on restart.
  const details = entry?.video ?? job.video ?? null
  // The media file itself - `location` falls back to the job's folder,
  // which has no extension to judge.
  const spotifyFile = entry?.file_path ?? primary?.path ?? null
  const spotifyFolders = useSettingsConfig().spotify.folders

  // Grouped by what the action is *for*, which is what the separators divide:
  // handling the file, controlling the job, copying things out, destroying.
  const file: RowAction[] = []
  const control: RowAction[] = []

  const info: RowAction[] = []
  const spotify: RowAction[] = []
  const danger: RowAction[] = []

  // Sending an existing file to Spotify. Shown even when the format is one
  // Spotify cannot play, greyed out with the reason in its tooltip - an action
  // that disappears for invisible reasons looks like a missing feature.
  if (spotifyFile && spotifyFolders.length > 0) {
    const playable = isSpotifyCompatible(spotifyFile)

    spotify.push({
      label: "Add to Spotify",
      hint: playable
        ? `Copy into ${spotifyFolders.length === 1 ? "your local files" : `${spotifyFolders.length} local-file folders`}`
        : "Spotify cannot play this format",
      icon: RiSpotifyLine,
      disabled: !playable,
      run: () => {
        // Always a copy from here: the library already knows this file and
        // has a signature for it, so taking it away would leave that record
        // pointing at nothing.
        void deliverToFolders(spotifyFile, spotifyFolders, true).then(
          ({ delivered, skipped, failures }) => {
            if (delivered === 0) {
              if (skipped > 0) {
                toast.info("Nothing added", {
                  description: "It is already in that folder.",
                })

                return
              }
              toast.error("Could not add to Spotify", {
                description: failures[0],
              })

              return
            }
            toast.success("Added to Spotify", {
              description:
                delivered === 1
                  ? "Copied into your local files."
                  : `Copied into ${delivered} folders.`,
            })
          }
        )
      },
    })
  }

  if (done && location && !missing) {
    const target = {
      url: primary?.url,
      // The library's path wins where it has one: it knows where the file is
      // now, not only where it was put.
      path: entry?.file_path ?? primary?.path,
      name: primary?.name,
      // The job API deals in absolute paths and the viewer route in
      // root-relative ones, so the root /health reported is what bridges them.
      // Null when the file sits outside the download folder, and opening then
      // falls back to the raw URL rather than a /view link that would 404.
      relativePath: relativeToRoot(
        primary?.path ?? null,
        health?.download_dir ?? null
      ),
    }

    file.push({
      // Named for what it does rather than kept uniform. In a browser this
      // opens a tab, and calling that "Open" invites the reasonable guess that
      // it opens in a player on this machine.
      label: capabilities.localFilesystem ? "Open" : "Open in a new tab",
      hint: primary?.name ?? "Open the downloaded file",
      icon: capabilities.localFilesystem
        ? RiPlayCircleLine
        : RiExternalLinkLine,
      run: () =>
        void checkThenRun(() => {
          void openFile(client, target).catch(reportFailure)
        }),
    })

    if (capabilities.downloadToBrowser) {
      file.push({
        label: "Download",
        hint: "Save it to this device",
        icon: RiDownload2Line,
        run: () =>
          void checkThenRun(() => {
            void downloadFile(client, target).catch(reportFailure)
          }),
      })
    }
  }

  if (location) {
    file.push({
      label: "Open file location",
      hint: location,
      icon: RiFolderOpenLine,
      run: () => {
        // The browser has no file manager to hand this to, so it gets the
        // dialog instead - and needs no existence check first, because the
        // listing is the check: a file that is gone simply is not in it.
        if (capabilities.fileBrowser) {
          fileBrowser.reveal(primary?.path ?? location)

          return
        }

        void checkThenRun(() => void revealPath(location).catch(reportFailure))
      },
    })
    file.push({
      label: "Copy file location",
      hint: location,
      icon: RiFileCopyLine,
      run: () => void copy(location, "File location copied"),
    })
  }

  // Always offered once the library knows the file is gone, so cancelling the
  // dialog is never a dead end - they can come back to it here.
  if (missing && entry) {
    file.push({
      label: "Locate file",
      hint: "Point Inferno at where the file went",
      icon: RiFileSearchLine,
      run: () => onLocate(entry),
    })
  }

  if (active) {
    control.push({
      label: "Cancel download",
      hint: "Cancel and stop this download",
      icon: RiCloseCircleLine,
      run: () => void cancel(job.job_id).catch(reportFailure),
    })
  }

  if (failed) {
    control.push({
      label: "Retry download",
      hint: "Queue this download again",
      icon: RiRefreshLine,
      run: () => void retry(job).catch(reportFailure),
    })
  }

  if (details) {
    info.push({
      label: "Video details",
      hint: "Everything known about this video",
      icon: RiInformationLine,
      run: () => onShowDetails(details),
    })
  }

  info.push({
    label: "Copy link",
    hint: "Copy the source URL",
    icon: RiLinkM,
    run: () => void copy(job.url, "Link copied"),
  })

  info.push({
    label: "Open link",
    hint: "Open the video in your browser",
    icon: RiExternalLinkLine,
    run: () => void openUrl(job.url).catch(reportFailure),
  })

  if (!active) {
    danger.push({
      label: "Remove",
      hint: "Remove this row; the file is kept",
      icon: RiEraserLine,
      run: () =>
        onConfirm({
          title: "Remove from the queue?",
          description: entry
            ? "Clears the row. The file stays on disk, and the download stays in your history."
            : "Clears the row. The file stays on disk.",
          confirmLabel: "Remove",
          run: () => void remove(job.job_id).catch(reportFailure),
        }),
    })

    if (done && location) {
      danger.push({
        label: "Delete",
        hint: location,
        icon: RiDeleteBinLine,
        destructive: true,
        run: () =>
          onConfirm({
            title: "Delete the file?",
            description: `Permanently deletes ${primary?.name ?? "this download"} from disk. This cannot be undone.`,
            confirmLabel: "Delete",
            destructive: true,
            run: () => void deleteDownload(),
          }),
      })
    }
  }

  // Its own section between the separators: sending a finished file
  // somewhere else is neither an info action nor a destructive one, and
  // sitting on its own is what keeps it from being clicked by accident
  // on the way to Delete.
  const actions = [file, control, info, spotify, danger]

  return (
    // Right-clicking the row offers exactly what the corner button offers -
    // one list of actions, two ways in.
    <RowContextMenu groups={actions}>
      <div
        className={cn(
          "flex items-center gap-4 border-b p-4",
          failed &&
            "shadow-[inset_3px_0_0_color-mix(in_oklab,var(--destructive)_55%,transparent)]"
        )}
      >
        <Thumbnail
          url={job.video?.thumbnail ?? null}
          title={title}
          onOpen={details ? () => onShowDetails(details) : undefined}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <div
              title={title}
              className="truncate text-[13px] font-semibold tracking-[0.01em]"
            >
              {title}
            </div>
            <div className="shrink-0 font-mono text-[9px] tracking-[0.04em] text-muted-foreground uppercase">
              {metaFor(tracker)}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {/* One segment per thing that actually happens: a merged video is
              two separate transfers and gets a bar each, so neither is
              stretched or squashed by the other's size. */}
            <div className="flex h-1.5 gap-0.5">
              {segments.map((segment) => (
                <StageSegment
                  key={segment.key}
                  value={failed ? (segment.value ?? 0) : segment.value}
                  grow={segment.grow}
                  fill={fill}
                />
              ))}
            </div>

            <div className="flex gap-2 font-mono text-[9px] tracking-[0.06em] uppercase">
              <div
                className={cn(
                  "flex-[0_0_68px] whitespace-nowrap",
                  lit(!failed && stage === "preparing"),
                  !failed && stage === "preparing" && "inferno-pulse"
                )}
              >
                {segments[0].label}
              </div>
              <div
                title={detail}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-2 truncate text-center",
                  failed
                    ? "text-destructive"
                    : done
                      ? "text-muted-foreground"
                      : lit(stage === "downloading")
                )}
              >
                <span className="truncate">{detail}</span>
                {/* Discoverable without opening the menu: the row itself says
                  the file is gone, and clicking offers to find it. */}
                {missing && entry ? (
                  <button
                    type="button"
                    onClick={() => onLocate(entry)}
                    className="shrink-0 text-destructive underline decoration-dotted underline-offset-2 hover:decoration-solid"
                  >
                    file moved &mdash; locate
                  </button>
                ) : null}
              </div>
              <div
                className={cn(
                  "flex-[0_0_68px] text-right whitespace-nowrap",
                  lit(!failed && stage === "processing")
                )}
              >
                {processing !== null && stage === "processing"
                  ? `${Math.round(processing)}%`
                  : "Cleanup"}
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0">
          <RowMenu groups={actions} />
        </div>
      </div>
    </RowContextMenu>
  )
}

function reportFailure(error: unknown) {
  toast.error(describeError(error))
}

async function copy(text: string, confirmation: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(confirmation)
  } catch {
    toast.error("Could not copy to the clipboard.")
  }
}

export function QueuePanel() {
  const {
    jobs,
    library,
    connection,
    problem,
    cancel,
    retry,
    remove,
    updateEntry,
    health,
  } = useInfernoService()

  // One dialog for the whole queue - only one file can be being located at a
  // time, and cancelling leaves the entry marked missing so the row's menu can
  // reopen it later.
  const [locating, setLocating] = useState<LibraryEntry | null>(null)
  // One details dialog for the whole queue; only one row can be inspected at
  // a time and this keeps the dialog out of every row's tree.
  const [details, setDetails] = useState<VideoInfo | null>(null)
  // Removing is not destructive to the file, but it is not obvious that it
  // is not - so it asks, and says what it actually does.
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null)

  const counts = jobs.reduce(
    (totals, { job }) => {
      if (job.status === "completed") {
        totals.finished += 1
      } else if (job.status === "failed" || job.status === "cancelled") {
        totals.errors += 1
      } else {
        totals.active += 1
      }

      return totals
    },
    { active: 0, finished: 0, errors: 0 }
  )

  // Anything the library remembers that is not a live job. Jobs vanish from
  // the service on restart, so after a relaunch this is the whole history.
  const liveJobIds = new Set(jobs.map(({ job }) => job.job_id))
  const earlier = library.filter((entry) => !liveJobIds.has(entry.job_id))
  const missingCount = library.filter(
    (entry) => entry.state === "missing"
  ).length

  const summary =
    connection === "offline"
      ? "service unavailable"
      : connection === "connecting"
        ? "connecting"
        : [
            `${counts.active} active`,
            `${counts.finished} finished`,
            `${counts.errors} errors`,
            missingCount > 0 ? `${missingCount} missing` : null,
          ]
            .filter(Boolean)
            .join(" · ")

  const cancelAll = () => {
    for (const { job } of jobs) {
      if (!terminalStatuses.includes(job.status)) {
        void cancel(job.job_id).catch(reportFailure)
      }
    }
  }

  const retryErrors = () => {
    for (const { job } of jobs) {
      if (job.status === "failed") {
        void retry(job).catch(reportFailure)
      }
    }
  }

  const clearFinished = () => {
    for (const { job } of jobs) {
      if (job.status === "completed") {
        void remove(job.job_id).catch(reportFailure)
      }
    }
  }

  // The command menu drives the same four controls the header offers.
  //
  // Reached by event rather than by lifting these handlers into a context: they
  // close over the live job list, which changes on every progress frame, so
  // hoisting them would re-render the whole app at that rate. `preventDefault`
  // is the acknowledgement - the palette only claims it did something when a
  // screen was actually listening.
  // The handlers close over the live job list, so they are new on every render
  // - and this panel re-renders on every progress frame. Kept in a ref and
  // subscribed once, rather than letting the effect re-run: an effect with no
  // dependency array would add and remove a window listener several times a
  // second for the whole of every download.
  const panelFileBrowser = useFileBrowser()
  const queueActions = useRef({ cancelAll, retryErrors, clearFinished, health })
  useEffect(() => {
    queueActions.current = { cancelAll, retryErrors, clearFinished, health }
  })

  useEffect(() => {
    function onAction(event: Event) {
      const action = (event as CustomEvent<string>).detail
      const current = queueActions.current

      const run: Record<string, () => void> = {
        "cancel-all": current.cancelAll,
        "retry-errors": current.retryErrors,
        "clear-finished": current.clearFinished,
        "open-folder": () => {
          // In the container this is the whole point of the browser dialog,
          // and it needs no path from /health to open - the API roots the
          // listing at the download folder itself.
          if (capabilities.fileBrowser) {
            panelFileBrowser.browse()

            return
          }

          const folder = current.health?.download_dir
          if (!folder) {
            toast.error("The service has not reported a download folder yet.")

            return
          }
          void openPath(folder).catch(reportFailure)
        },
      }

      const handler = run[action]
      if (handler) {
        event.preventDefault()
        handler()
      }
    }

    window.addEventListener("inferno-app:queue-action", onAction)

    return () => {
      window.removeEventListener("inferno-app:queue-action", onAction)
    }
    // Everything else this handler needs it reads through `queueActions`, a
    // ref, precisely so the listener is bound once. The browser handle is the
    // exception: it is stable by construction (memoised in the provider, and a
    // shared constant where there is none), so depending on it costs nothing
    // and keeps the rule honest rather than silenced.
  }, [panelFileBrowser])

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 p-4">
      <div className="flex shrink-0 items-baseline justify-between gap-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <div className="text-xs font-semibold tracking-widest uppercase">
            Queue
          </div>
          <div className="truncate font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            {summary}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-4">
          <RuleButton rule={false} onClick={cancelAll}>
            Cancel all
          </RuleButton>
          <RuleButton rule={false} onClick={retryErrors}>
            Retry errors
          </RuleButton>
          <RuleButton rule={false} onClick={clearFinished}>
            Clear finished
          </RuleButton>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 bg-card shadow-[0_0_0_1px_color-mix(in_oklab,var(--foreground)_8%,transparent)]">
        <div className="flex flex-col">
          {jobs.map((tracker) => (
            <QueueRowItem
              key={tracker.job.job_id}
              tracker={tracker}
              onLocate={setLocating}
              onShowDetails={setDetails}
              onConfirm={setConfirming}
            />
          ))}

          {earlier.length > 0 ? (
            <>
              <div className="flex items-center gap-3 border-b bg-muted/20 px-4 py-2 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase">
                <span>Earlier downloads</span>
                <span className="h-px flex-1 bg-border" />
                <span>{earlier.length}</span>
              </div>
              {earlier.map((entry) => (
                <LibraryRow
                  key={entry.id}
                  entry={entry}
                  onLocate={setLocating}
                  onShowDetails={setDetails}
                  onConfirm={setConfirming}
                />
              ))}
            </>
          ) : null}

          <div className="flex items-center justify-center p-4 text-center font-mono text-[9.5px] tracking-[0.12em] text-muted-foreground uppercase">
            <span>{problem ?? dropHint}</span>
          </div>
        </div>
      </ScrollArea>

      <LocateFileDialog
        entry={locating}
        open={locating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLocating(null)
          }
        }}
        onLocated={updateEntry}
      />

      <ConfirmDialog
        request={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
          }
        }}
      />

      <VideoDetailsDialog
        video={details}
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetails(null)
          }
        }}
      />
    </div>
  )
}
