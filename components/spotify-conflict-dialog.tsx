"use client"

import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { formatBytes } from "@/lib/format"
import { useLingering } from "@/lib/use-lingering"
import {
  setConflictAsker,
  type ConflictAnswer,
  type ConflictDecision,
  type ConflictQuestion,
} from "@/lib/spotify-conflicts"

function whenModified(seconds: number | null) {
  if (!seconds) {
    return "unknown date"
  }

  return new Date(seconds * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * "Something is already called that" - and what to do about it.
 *
 * Mounted once at the app root and registered as the answer to
 * `askAboutConflict`, so both the automatic delivery and the row menu ask the
 * same question through the same dialog. Nothing has been written by the time
 * this appears; the file on disk is untouched until a button is pressed.
 *
 * Dismissing counts as Skip, not as a default action. Closing a dialog should
 * never be the thing that overwrites someone's music.
 */
export function SpotifyConflictDialog() {
  const [question, setQuestion] = useState<ConflictQuestion | null>(null)
  const [applyToRest, setApplyToRest] = useState(false)
  // The promise the delivery is parked on, resolved by whichever button wins.
  const [resolver, setResolver] = useState<
    ((answer: ConflictAnswer) => void) | null
  >(null)

  useEffect(() => {
    setConflictAsker(
      (next) =>
        new Promise<ConflictAnswer>((resolve) => {
          setQuestion(next)
          setApplyToRest(false)
          // Wrapped: `setState` treats a bare function as an updater.
          setResolver(() => resolve)
        })
    )

    return () => {
      setConflictAsker(null)
    }
  }, [])

  const answer = useCallback(
    (decision: ConflictDecision) => {
      resolver?.({ decision, applyToRest })
      setQuestion(null)
      setResolver(null)
    },
    [applyToRest, resolver]
  )

  const shown = useLingering(question)

  if (!shown) {
    return null
  }

  return (
    <Dialog
      open={question !== null}
      onOpenChange={(open) => {
        if (!open) {
          answer("skip")
        }
      }}
    >
      <DialogContent showCloseButton={false} className="*:min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base normal-case">
            That name is already taken
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            <span className="font-medium text-foreground">
              {shown.existingName}
            </span>{" "}
            is already in that folder.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-border pl-3 text-[12.5px]">
          <div>
            <div className="font-medium">Already there</div>
            <div className="text-muted-foreground">
              {formatBytes(shown.existingSize)} ·{" "}
              {whenModified(shown.existingModified)}
            </div>
          </div>
          <div className="font-mono text-[10px] wrap-anywhere text-muted-foreground">
            {shown.folder}
          </div>
        </div>

        {/* Only when there is a "rest" to apply it to. */}
        {shown.remaining > 0 ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="spotify-conflict-all"
              checked={applyToRest}
              onCheckedChange={(checked) => setApplyToRest(checked === true)}
            />
            <Label
              htmlFor="spotify-conflict-all"
              className="text-xs font-normal text-muted-foreground"
            >
              Do the same for the other {shown.remaining}
            </Label>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => answer("skip")}>
            Skip
          </Button>
          <Button variant="outline" size="sm" onClick={() => answer("replace")}>
            Replace
          </Button>
          {/* The primary, because it is the one that cannot lose anything. */}
          <Button size="sm" onClick={() => answer("keep_both")}>
            Keep both
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
