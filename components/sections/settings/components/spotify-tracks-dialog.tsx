"use client"

import { useEffect, useState } from "react"
import { RiFolderOpenLine, RiMusic2Line } from "@remixicon/react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { openPath } from "@/lib/inferno-service"
import { formatBytes } from "@/lib/format"
import {
  isSpotifyCompatible,
  listSpotifyTracks,
  type SpotifyTrack,
} from "@/lib/spotify"
import { useLingering } from "@/lib/use-lingering"
import { cn } from "@/lib/utils"

function whenAdded(seconds: number | null) {
  if (!seconds) {
    return ""
  }

  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/**
 * The shape of the list, before the list exists.
 *
 * Every tag has to be read off disk, so this is not instant on a real library -
 * and a spinner in the middle of an empty dialog gives no sense of what is
 * coming. Laid out in the same grid as the real rows, with the same borders and
 * the same artwork square, so the content lands in place instead of replacing
 * something that looked nothing like it.
 *
 * Widths vary per row on purpose: identical bars read as a loading graphic,
 * uneven ones read as text that has not arrived.
 */
function TrackListSkeleton() {
  const widths = ["w-40", "w-56", "w-32", "w-48", "w-36", "w-44"]

  return (
    <div className="min-h-0 flex-1 overflow-hidden border" aria-hidden>
      <div className="border-b bg-popover px-3 py-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
        Reading tags…
      </div>
      {widths.map((width, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
        >
          <Skeleton className="size-8 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-3", width)} />
            <Skeleton className="h-2 w-24" />
          </div>
          <Skeleton className="h-2.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** The name without its extension, for a file that carries no title tag. */
function fallbackTitle(track: SpotifyTrack) {
  return track.file_name.replace(/\.[^.]+$/, "")
}

/**
 * What is actually in a local-files folder.
 *
 * Tags where a file has them, filename where it does not - and it says which,
 * rather than inventing an artist. A folder full of untagged files is a real
 * situation (a download that skipped its metadata step, files copied from
 * somewhere careless), and quietly showing blanks would look like the reader
 * was broken.
 *
 * Mounted with a `key` of the folder, so opening a different one starts from
 * empty state rather than showing the last folder's songs while the new ones
 * load.
 */
export function SpotifyTracksDialog({
  folder,
  onOpenChange,
}: {
  folder: string | null
  onOpenChange: (open: boolean) => void
}) {
  // Both results carry the folder they describe. This used to be handled with
  // a `key` on the component, which reset everything when the folder changed -
  // but a key that becomes null on close destroys the whole component mid-fade,
  // so the dialog vanished instead of animating away. Keeping the folder
  // alongside the data answers "is this still about the folder on screen?"
  // without throwing the component away to do it.
  const [loaded, setLoaded] = useState<{
    folder: string
    rows: SpotifyTrack[]
  } | null>(null)
  const [failed, setFailed] = useState<{
    folder: string
    message: string
  } | null>(null)

  useEffect(() => {
    if (!folder) {
      return
    }

    let live = true

    listSpotifyTracks(folder)
      .then((rows) => {
        if (live) {
          setLoaded({ folder, rows: rows ?? [] })
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setFailed({
            folder,
            message:
              error instanceof Error
                ? error.message
                : "Could not read the folder.",
          })
        }
      })

    return () => {
      live = false
    }
  }, [folder])

  const shown = useLingering(folder)

  if (!shown) {
    return null
  }

  // Only this folder's own results; anything else is the last one still on
  // screen behind a dialog that is closing.
  const tracks = loaded?.folder === shown ? loaded.rows : null
  const problem = failed?.folder === shown ? failed.message : null

  return (
    <Dialog open={folder !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base normal-case">
            Songs in this folder
          </DialogTitle>
          {/* The path reads right-to-left so the folder itself stays visible
              when it is too long - see the table in the settings panel - and
              it opens the folder, like the one in the settings table does. */}
          <DialogDescription
            render={
              <button
                type="button"
                onClick={() => {
                  void openPath(shown).catch((error: unknown) => {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Could not open that folder."
                    )
                  })
                }}
                title={`Open ${shown}`}
              />
            }
            className="group/path flex w-full min-w-0 items-center gap-1.5 text-left transition-colors hover:text-foreground"
          >
            <span
              dir="rtl"
              className="min-w-0 truncate text-left font-mono text-[10px] underline decoration-transparent underline-offset-2 transition-colors group-hover/path:decoration-current"
            >
              {shown}
            </span>
            <RiFolderOpenLine className="size-3 shrink-0" />
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <p className="py-8 text-center text-sm text-destructive">{problem}</p>
        ) : tracks === null ? (
          <TrackListSkeleton />
        ) : tracks.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Nothing here yet.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto border">
            <table className="w-full border-collapse text-left text-sm">
              {/* Sticky, so the columns stay named while scrolling a long
                  library. */}
              <thead className="sticky top-0 z-10 bg-popover">
                <tr className="border-b text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                  <th className="w-16 px-3 py-2" />
                  <th className="px-3 py-2">Track</th>
                  <th className="px-3 py-2 text-right">Size</th>
                  <th className="hidden px-3 py-2 text-right md:table-cell">
                    Added
                  </th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => {
                  const playable = isSpotifyCompatible(track.path)

                  return (
                    <tr
                      key={track.path}
                      className={cn(
                        "border-b last:border-b-0",
                        // A file Spotify cannot play is dimmed rather than
                        // hidden: it is in the folder, and not seeing it is
                        // exactly how you end up wondering where it went.
                        !playable && "opacity-50"
                      )}
                      title={playable ? track.path : "Spotify cannot play this"}
                    >
                      <td className="px-3 py-2">
                        {track.artwork ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={track.artwork}
                            alt=""
                            width={32}
                            height={32}
                            draggable={false}
                            className="size-8 min-w-8 shrink-0 object-cover select-none"
                          />
                        ) : (
                          <div className="inferno-hatch flex size-8 min-w-8 shrink-0 items-center justify-center">
                            <RiMusic2Line className="size-3 text-muted-foreground" />
                          </div>
                        )}
                      </td>
                      {/* Two lines in one cell rather than two columns.
                          A title and its artist are read together, and side
                          by side they were each truncating at half the width
                          they now share. */}
                      <td className="max-w-96 px-3 py-2">
                        <div className="truncate font-medium">
                          {track.title ?? fallbackTitle(track)}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {track.artist ?? "Unknown artist"}
                          {track.title ? null : " · title from the filename"}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatBytes(track.size)}
                      </td>
                      <td className="hidden px-3 py-2 text-right whitespace-nowrap text-muted-foreground md:table-cell">
                        {whenAdded(track.modified)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {tracks && tracks.length > 0 ? (
          <p className="text-[10px] text-muted-foreground">
            {tracks.length === 500
              ? "Showing the 500 most recent files."
              : `${tracks.length} ${tracks.length === 1 ? "file" : "files"}.`}{" "}
            Dimmed rows are formats Spotify will not play.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
