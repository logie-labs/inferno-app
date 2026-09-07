"use client"

import type { ReactNode } from "react"

import { useLingering } from "@/lib/use-lingering"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * What a confirmation is asking, carried from the action that raised it.
 *
 * The wording lives beside the code that performs the action rather than here,
 * because only that code knows what actually happens - which is the whole
 * point of asking.
 */
export type ConfirmRequest = {
  title: string
  /**
   * What the action really does, in plain terms.
   *
   * A node, not a string, so a confirmation can show the thing it is talking
   * about - a shortcut as real keycaps, say - rather than describing it. The
   * description renders as a paragraph, so keep it to phrasing content.
   */
  description: ReactNode
  confirmLabel: string
  destructive?: boolean
  run: () => void
}

/**
 * An ordinary dialog rather than an alert dialog.
 *
 * An alert dialog refuses to close on a click outside or on Escape, forcing a
 * choice. That is the right pattern for a question where dismissing is itself
 * ambiguous - but none of these are: every way out except the confirm button
 * means "don't", so a click on the backdrop is already an unambiguous answer,
 * and refusing it only makes the dialog feel like it has trapped you.
 *
 * It costs the `alertdialog` role, which a screen reader announces more
 * assertively. The title and description are still wired up as the dialog's
 * accessible name and description, so what is being asked is announced either
 * way.
 */
export function ConfirmDialog({
  request,
  onOpenChange,
}: {
  request: ConfirmRequest | null
  onOpenChange: (open: boolean) => void
}) {
  // `request` is cleared as this closes, so the last one is held on to for as
  // long as the dialog is still on screen animating away.
  const shown = useLingering(request)

  if (!shown) {
    return null
  }

  return (
    // `open` is derived rather than hardcoded: a dialog that is only ever
    // `open` cannot animate closed, it can only be removed.
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      {/* No corner close: Cancel says the same thing, and two ways to decline
          sitting next to each other read as two different outcomes. */}
      <DialogContent showCloseButton={false} className="*:min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base normal-case">
            {shown.title}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {shown.description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant={shown.destructive ? "destructive" : "default"}
            onClick={() => {
              shown.run()
              onOpenChange(false)
            }}
          >
            {shown.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
