"use client"

import {
  RiDeleteBinLine,
  RiEraserLine,
  RiFileCopyLine,
  RiFileSearchLine,
  RiFolderOpenLine,
  RiExternalLinkLine,
  RiInformationLine,
  RiLinkM,
  RiPlayCircleLine,
  RiSpotifyLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { useSettingsConfig } from "@/components/sections/settings/settings-config"
import { formatBytes } from "@/lib/format"
import { deliverToFolders, isSpotifyCompatible } from "@/lib/spotify"
import {
  verifyEntry,
  type Deletion,
  type LibraryEntry,
} from "@/lib/inferno-library"
import {
  describeError,
  openPath,
  openUrl,
  revealPath,
  type VideoInfo,
} from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import type { ConfirmRequest } from "./confirm-dialog"
import { RowContextMenu, RowMenu, type RowAction } from "./row-menu"
import { Thumbnail } from "./thumbnail"
import { useInfernoService } from "./service-context"

function reportFailure(error: unknown) {
  toast.error(describeError(error))
}

/** Delete the file, then say what actually happened to it. */
async function deleteFile(
  entry: LibraryEntry,
  destroy: (entry: LibraryEntry) => Promise<Deletion | null>
) {
  try {
    const outcome = await destroy(entry)
    if (!outcome) {
      return
    }
    if (outcome.problem) {
      toast.error("Could not delete the file", {
        description: outcome.problem,
      })
    } else if (outcome.already_gone) {
      toast.info("The file was already gone", {
        description: "Removed it from your history.",
      })
    } else {
      toast.success("Deleted", {
        description: `${entry.file_name ?? "The file"} was deleted from disk.`,
      })
    }
  } catch (error) {
    reportFailure(error)
  }
}

async function copy(text: string, confirmation: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(confirmation)
  } catch {
    toast.error("Could not copy to the clipboard.")
  }
}

/** `12 Mar 2026` for anything older than today. */
function when(seconds: number) {
  const date = new Date(seconds * 1000)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()

  return sameDay
    ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
}

/**
 * A download from a previous session.
 *
 * The service keeps jobs in memory and forgets them on restart (SPEC §2), so
 * without these rows the library would be write-only - and "Locate file" would
 * be unreachable for exactly the downloads most likely to have been moved.
 */
export function LibraryRow({
  entry,
  onLocate,
  onShowDetails,
  onConfirm,
}: {
  entry: LibraryEntry
  onLocate: (entry: LibraryEntry) => void
  onShowDetails: (video: VideoInfo) => void
  onConfirm: (request: ConfirmRequest) => void
}) {
  const { forget, destroy, updateEntry } = useInfernoService()

  const missing = entry.state === "missing"
  const mismatched = entry.state === "mismatched"
  const title = entry.title ?? entry.url

  /** Re-check before acting, rather than polling. */
  const checkThenRun = async (run: () => void) => {
    const current = await verifyEntry(entry.id).catch(() => null)
    if (current) {
      updateEntry(current)
      if (current.state === "missing") {
        onLocate(current)

        return
      }
    }
    run()
  }

  const spotifyFolders = useSettingsConfig().spotify.folders

  // Same grouping as a live row, so the two menus read identically.
  const file: RowAction[] = []
  const info: RowAction[] = []
  const spotify: RowAction[] = []
  const danger: RowAction[] = []

  // Sending an existing file to Spotify. Shown even when the format is one
  // Spotify cannot play, greyed out with the reason in its tooltip - an action
  // that disappears for invisible reasons looks like a missing feature.
  if (entry.file_path && spotifyFolders.length > 0) {
    const target = entry.file_path
    const playable = isSpotifyCompatible(target)

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
        void deliverToFolders(target, spotifyFolders, true).then(
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

  if (entry.file_path) {
    file.push({
      label: "Open",
      hint: entry.file_name ?? "Open the downloaded file",
      icon: RiPlayCircleLine,
      run: () =>
        void checkThenRun(() => {
          void openPath(entry.file_path ?? "").catch(reportFailure)
        }),
    })
    file.push({
      label: "Open file location",
      hint: entry.file_path,
      icon: RiFolderOpenLine,
      run: () =>
        void checkThenRun(() => {
          void revealPath(entry.file_path ?? "").catch(reportFailure)
        }),
    })
    file.push({
      label: "Copy file location",
      hint: entry.file_path,
      icon: RiFileCopyLine,
      run: () => void copy(entry.file_path ?? "", "File location copied"),
    })
  }

  if (missing) {
    file.push({
      label: "Locate file",
      hint: "Point Inferno at where the file went",
      icon: RiFileSearchLine,
      run: () => onLocate(entry),
    })
  }

  if (entry.video) {
    info.push({
      label: "Video details",
      hint: "Everything known about this video",
      icon: RiInformationLine,
      run: () => onShowDetails(entry.video as VideoInfo),
    })
  }

  info.push({
    label: "Copy link",
    hint: "Copy the source URL",
    icon: RiLinkM,
    run: () => void copy(entry.url, "Link copied"),
  })

  info.push({
    label: "Open link",
    hint: "Open the video in your browser",
    icon: RiExternalLinkLine,
    run: () => void openUrl(entry.url).catch(reportFailure),
  })

  danger.push({
    label: "Remove",
    hint: "Forget this download; the file is left alone",
    icon: RiEraserLine,
    run: () =>
      onConfirm({
        title: "Remove from history?",
        description: "Forgets this download. The file stays on disk.",
        confirmLabel: "Remove",
        run: () => void forget(entry).catch(reportFailure),
      }),
  })

  danger.push({
    label: "Delete",
    hint: entry.file_path ?? "Delete the file from disk",
    icon: RiDeleteBinLine,
    destructive: true,
    run: () =>
      onConfirm({
        title: "Delete the file?",
        description: `Permanently deletes ${entry.file_name ?? "this download"} from disk. This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
        run: () => void deleteFile(entry, destroy),
      }),
  })

  const meta = [
    entry.format_summary,
    entry.size ? formatBytes(entry.size) : null,
    when(entry.downloaded_at),
  ]
    .filter(Boolean)
    .join(" · ")

  const actions = [file, info, spotify, danger]

  return (
    <RowContextMenu groups={actions}>
      <div
        className={cn(
          "flex items-center gap-4 border-b p-4",
          missing &&
            "shadow-[inset_3px_0_0_color-mix(in_oklab,var(--destructive)_35%,transparent)]"
        )}
      >
        <Thumbnail
          url={entry.thumbnail ?? null}
          title={title}
          dimmed={missing}
          onOpen={
            entry.video
              ? () => onShowDetails(entry.video as VideoInfo)
              : undefined
          }
        />

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <div
              title={title}
              className={cn(
                "truncate text-[13px] font-semibold tracking-[0.01em]",
                missing && "text-muted-foreground"
              )}
            >
              {title}
            </div>
            {entry.channel ? (
              <div className="shrink-0 truncate font-mono text-[9px] tracking-[0.04em] text-muted-foreground">
                {entry.channel}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2 font-mono text-[9px] tracking-[0.06em] uppercase">
            <span className="text-muted-foreground">{meta}</span>
            {missing ? (
              <button
                type="button"
                onClick={() => onLocate(entry)}
                className="text-destructive underline decoration-dotted underline-offset-2 hover:decoration-solid"
              >
                file moved &mdash; locate
              </button>
            ) : null}
            {mismatched ? (
              <span
                className="text-destructive"
                title="The located file does not match the original download."
              >
                different file
              </span>
            ) : null}
          </div>

          {/* Where it actually landed. Worth a line of its own rather than
              only living on the menu: the output template can put a file
              somewhere the download settings do not obviously imply, and
              "where did that go" is the question this row is asked most.
              Truncated from the tail, which keeps the folder - the half
              somebody is reading for - while the file name is already the
              title above.

              Not uppercased like the line above it. That line is three short
              labels and reads fine shouted; a path is neither. */}
          {entry.file_path ? (
            missing ? (
              // No button while the file is gone: revealing it would fail,
              // and the row already offers the one thing that helps.
              <span
                title={entry.file_path}
                className="max-w-full self-start truncate font-mono text-[9px] tracking-[0.04em] text-muted-foreground/70"
              >
                {entry.file_path}
              </span>
            ) : (
              <button
                type="button"
                title={`${entry.file_path}
Show in folder`}
                onClick={() =>
                  void revealPath(entry.file_path ?? "").catch(reportFailure)
                }
                className="flex max-w-full min-w-0 items-center gap-1 self-start font-mono text-[9px] tracking-[0.04em] text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                <RiFolderOpenLine aria-hidden className="size-2.5 shrink-0" />
                <span className="truncate underline decoration-dotted underline-offset-2">
                  {entry.file_path}
                </span>
              </button>
            )
          ) : null}
        </div>

        <div className="shrink-0">
          <RowMenu groups={actions} />
        </div>
      </div>
    </RowContextMenu>
  )
}
