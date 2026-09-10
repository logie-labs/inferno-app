"use client"

/**
 * The download queue, reflected in the app's own taskbar button.
 *
 * The one piece of the app that is useful while it is not the window you are
 * looking at: a download is minutes of waiting, and the whole point of putting
 * it on the taskbar is to not have to come back and check.
 *
 * Renders nothing. It exists to hold a subscription and turn it into one
 * number.
 */

import { useEffect } from "react"

import { useInfernoService } from "@/components/sections/downloads/service-context"
import { downloadPercent } from "@/lib/inferno-progress"
import { terminalStatuses } from "@/lib/inferno-service"
import { tauriWindow } from "@/lib/tauri-window"

/**
 * Said once, then never again.
 *
 * The first version of this swallowed every failure silently, on the reasoning
 * that a taskbar bar is cosmetic. What that actually bought was a feature that
 * did nothing and said nothing: the call was being refused because
 * `core:window:allow-set-progress-bar` was missing from the capability file,
 * and there was no way to tell that from "this desktop has no taskbar
 * progress". A misconfiguration should be visible somewhere, and a repeating
 * warning at ten frames a second is its own kind of useless.
 */
let complained = false

function reportOnce(error: unknown) {
  if (complained) {
    return
  }

  complained = true
  console.warn("Taskbar progress is unavailable:", error)
}

export function TaskbarProgress() {
  // Subscribing here means re-rendering on every progress frame, which is the
  // thing the settings screen goes out of its way to avoid. It is the right
  // trade in this one component: it renders null, so a render costs nothing,
  // and live progress is the entire feature. What is guarded is the *effect*
  // below, which is where the real cost would be.
  const { jobs } = useInfernoService()

  const active = jobs.filter(
    (tracker) => !terminalStatuses.includes(tracker.job.status)
  )

  // Averaged across the queue rather than shown for the newest job. The
  // taskbar has room for one number and the honest one is "how far through is
  // all of this", which is also the number that only ever moves forwards as
  // jobs finish.
  //
  // A job that is past downloading reports 100 here and is carried by the
  // average while it merges, which is the same thing the queue's own bars say.
  const measured = active
    .map((tracker) => downloadPercent(tracker))
    .filter((percent): percent is number => percent !== null)

  const status =
    active.length === 0
      ? "none"
      : measured.length === 0
        ? // Something is running but nothing has reported a size yet. A
          // determinate 0% would read as stuck.
          "indeterminate"
        : "normal"

  const percent =
    measured.length === 0
      ? null
      : Math.round(
          measured.reduce((total, value) => total + value, 0) / measured.length
        )

  // Keyed on the rounded percent, so the effect fires about a hundred times
  // across a download rather than on every frame the service sends. Each call
  // is an IPC round trip; there is no point spending one to move a bar by a
  // fraction of a pixel.
  useEffect(() => {
    void tauriWindow.setProgress(status, percent).catch(reportOnce)
  }, [status, percent])

  // Clearing on unmount matters more than it looks: the button keeps whatever
  // it was last told, so a window closed mid-download would otherwise leave a
  // half-filled bar behind on a relaunch.
  useEffect(() => {
    return () => {
      void tauriWindow.setProgress("none").catch(reportOnce)
    }
  }, [])

  return null
}
