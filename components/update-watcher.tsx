"use client"

/**
 * The scheduled half of the update check: on launch, on a timer, on request.
 *
 * At the app root rather than on the settings screen, because the answer is
 * wanted by people who never open that screen - a yt-dlp that has gone stale
 * shows up as downloads failing, and the only useful moment to say so is when
 * it is noticed, not when somebody happens to go looking.
 *
 * Renders nothing. Everything it learns goes into the store in `lib/updates`,
 * which the Updates screen reads; all this owns is *when* to ask and whether
 * to interrupt anybody about the answer.
 */

import { useCallback, useEffect, useRef } from "react"

import { toast } from "sonner"

import { useActiveSection } from "@/components/sections/active-section-context"
import { loadSettingsConfig } from "@/components/sections/settings/settings-config"
import { requestSettingsSection } from "@/components/sections/settings/settings-navigation"
import {
  checkForUpdates,
  failedComponents,
  outdatedComponents,
  updateCheckRequestEvent,
  type UpdateReport,
} from "@/lib/updates"

/**
 * How long the launch check waits for the sidecar before reporting without it.
 *
 * The service is spawned as the window opens and takes a moment to answer, so
 * a check that ran immediately would report "yt-dlp: not running" on every
 * single launch - which teaches people to ignore the one notification that
 * matters. Generous, because nothing is waiting on it.
 */
const SERVICE_GRACE = 20_000

export function UpdateWatcher() {
  const { setActive } = useActiveSection()

  const announce = useCallback(
    (report: UpdateReport, requested: boolean) => {
      const behind = outdatedComponents(report)
      const failed = failedComponents(report)

      if (behind.length === 0) {
        // Nothing to report. A check somebody actually asked for still gets an
        // answer - silence would be indistinguishable from it not running.
        if (requested) {
          if (failed.length > 0) {
            toast.warning("Some checks could not complete", {
              description: failed[0].message ?? undefined,
            })
          } else {
            toast.success("Everything is up to date")
          }
        }

        return
      }

      // Read fresh: this fires long after the timer was set, and the
      // preference may have been turned off in between.
      if (!requested && !loadSettingsConfig().updates.notify) {
        return
      }

      toast.info(
        behind.length === 1
          ? `${behind[0].name} has an update available`
          : `${behind.length} components have updates available`,
        {
          description:
            behind.length === 1
              ? (behind[0].message ?? undefined)
              : behind.map((entry) => entry.name).join(", "),
          action: {
            label: "View",
            onClick: () => {
              // The request beats the remembered nav position, so this lands
              // on Updates whether or not "reopen last section" is on.
              requestSettingsSection("updates")
              setActive("settings")
            },
          },
        }
      )
    },
    [setActive]
  )

  // A ref so the launch effect can stay a genuine once-per-mount effect
  // without closing over a stale `announce`.
  const announceRef = useRef(announce)
  useEffect(() => {
    announceRef.current = announce
  }, [announce])

  // The launch check. Deliberately reads the setting rather than depending on
  // it: turning "check on launch" *on* is not a launch, and an effect that
  // re-ran on the preference would fire a check the moment it was switched.
  useEffect(() => {
    const settings = loadSettingsConfig().updates

    if (!settings.checkOnLaunch) {
      return
    }

    void checkForUpdates(settings, { waitForService: SERVICE_GRACE })
      .then((report) => announceRef.current(report, false))
      .catch(() => {
        // A check nobody asked for fails quietly. The Updates screen still
        // carries the last result and the reason each row is where it is.
      })
  }, [])

  // "Check for updates" from the command menu.
  useEffect(() => {
    const onRequested = () => {
      void checkForUpdates(loadSettingsConfig().updates)
        .then((report) => announceRef.current(report, true))
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : "The check could not run."
          )
        })
    }

    window.addEventListener(updateCheckRequestEvent, onRequested)

    return () =>
      window.removeEventListener(updateCheckRequestEvent, onRequested)
  }, [])

  return null
}
