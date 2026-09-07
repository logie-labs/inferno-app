"use client"

import { useEffect, useState } from "react"
import { RiAlertLine, RiFileSearchLine, RiQuestionLine } from "@remixicon/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  locateEntry,
  relocateEntry,
  type LibraryEntry,
} from "@/lib/inferno-library"
import { existingAncestor } from "@/lib/inferno-service"
import { useLingering } from "@/lib/use-lingering"

/** The last segment of a path, whichever separator it uses. */
function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

/**
 * Offered when a download's file is no longer where it was put.
 *
 * Two questions, in order. First "where did it go" - and then, only when the
 * chosen file does not match the signature taken at download time, "is this
 * really it?". That second one is a judgement the app cannot make: a trimmed
 * or re-encoded copy is still the file they meant, a wrong pick is not, and
 * from here the two are indistinguishable. So nothing is applied until they
 * say which it is.
 *
 * Cancelling either question is safe - the entry stays marked missing and the
 * row's menu keeps offering "Locate file".
 */
export function LocateFileDialog({
  entry,
  open,
  onOpenChange,
  onLocated,
}: {
  entry: LibraryEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onLocated: (entry: LibraryEntry) => void
}) {
  const [searching, setSearching] = useState(false)
  /** A picked file that did not match, waiting on a decision. */
  const [candidate, setCandidate] = useState<string | null>(null)

  // How far down the path still exists. Resolved once per opening: the walk is
  // one `exists` per segment - far too cheap to repeat on render, but not
  // something to do in the render path either.
  //
  // Keyed by the path it describes so "which path is this about" is derived
  // rather than kept in sync by an effect that writes state on the way in.
  const [probe, setProbe] = useState<{
    path: string
    survives: string | null
  } | null>(null)

  const path = entry?.file_path ?? null
  const survives = probe?.path === path ? probe.survives : null

  useEffect(() => {
    if (!open || !path) {
      return
    }

    let live = true
    existingAncestor(path).then((found) => {
      if (live) {
        setProbe({ path, survives: found })
      }
    })

    return () => {
      live = false
    }
  }, [open, path])

  // Held on to across the close, so the dialog can fade rather than vanish.
  const shown = useLingering(entry)

  if (!shown) {
    return null
  }

  const name = shown.file_name ?? shown.title ?? "This download"

  // Split the path where the trail goes cold: everything that still resolves
  // reads as ordinary text, and the first segment that does not is the answer
  // to "what happened". Before the probe returns, the whole path is simply
  // shown plainly rather than flashing a guess.
  const found = survives && path?.startsWith(survives) ? survives : null
  const gone = found && path ? path.slice(found.length) : null

  const close = () => {
    setCandidate(null)
    onOpenChange(false)
  }

  const settle = (located: LibraryEntry, matched: boolean) => {
    onLocated(located)
    toast.success(matched ? "File relocated" : "Using the file you picked", {
      description: matched
        ? `${located.file_name ?? "The file"} matches the original download.`
        : "It is marked as changed, so the difference is not forgotten.",
    })
    close()
  }

  const locate = async () => {
    setSearching(true)
    try {
      const result = await locateEntry(shown.id)
      if (!result || result.cancelled) {
        return
      }

      if (result.entry) {
        settle(result.entry, true)
      } else if (result.candidate) {
        // Nothing has been applied yet - ask before changing anything.
        setCandidate(result.candidate)
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not locate it."
      )
    } finally {
      setSearching(false)
    }
  }

  const acceptAnyway = async () => {
    if (!candidate) {
      return
    }

    setSearching(true)
    try {
      const located = await relocateEntry(shown.id, candidate)
      if (located) {
        settle(located, false)
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not use that file."
      )
    } finally {
      setSearching(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close()
        }
      }}
    >
      {/* No corner close: Cancel below does the same job, and the two together
          read as a choice between different things. `min-w-0` on the grid
          items is what lets a long path wrap instead of pushing the dialog
          open - grid children default to `min-width: auto`. */}
      <DialogContent
        showCloseButton={false}
        className="gap-4 *:min-w-0 sm:max-w-md"
      >
        {candidate ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base normal-case">
                <RiQuestionLine className="size-4 shrink-0 text-destructive" />
                This is not the same file
              </DialogTitle>
              <DialogDescription>
                Its contents differ from what was downloaded. That happens if it
                has been edited or re-encoded &mdash; or if it is a different
                file altogether.
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-w-0 flex-col gap-1 border-l-2 border-border pl-3">
              <span className="text-[12.5px] font-medium wrap-anywhere">
                {baseName(candidate)}
              </span>
              <span className="font-mono text-[10px] leading-relaxed wrap-anywhere text-muted-foreground">
                {candidate}
              </span>
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={close}
                disabled={searching}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void acceptAnyway()}
                disabled={searching}
              >
                Use it anyway
              </Button>
              <Button
                size="sm"
                onClick={() => void locate()}
                disabled={searching}
              >
                {searching ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RiFileSearchLine
                    data-icon="inline-start"
                    className="size-3.5"
                  />
                )}
                Locate again
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base normal-case">
                <RiAlertLine className="size-4 shrink-0 text-destructive" />
                File not found
              </DialogTitle>
              <DialogDescription>
                It may have been moved, renamed or deleted.
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-w-0 flex-col gap-1 border-l-2 border-border pl-3">
              <span className="text-[12.5px] font-medium wrap-anywhere">
                {name}
              </span>
              {path ? (
                <p className="font-mono text-[10px] leading-relaxed wrap-anywhere text-muted-foreground">
                  {found ? (
                    <>
                      {found}
                      <span className="text-destructive line-through decoration-destructive/50">
                        {gone}
                      </span>
                    </>
                  ) : (
                    path
                  )}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={close}
                disabled={searching}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void locate()}
                disabled={searching}
              >
                {searching ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RiFileSearchLine
                    data-icon="inline-start"
                    className="size-3.5"
                  />
                )}
                Locate file
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
