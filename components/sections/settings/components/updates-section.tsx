"use client"

import { useEffect, useState } from "react"

import {
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiFolderOpenLine,
  RiLoopRightLine,
  RiQuestionLine,
  RiRefreshLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { describeError, openUrl, revealPath } from "@/lib/inferno-service"
import {
  bundledComponents,
  checkForUpdates,
  DEFAULT_APP_REPO,
  describeAge,
  describeFeed,
  failedComponents,
  missingComponents,
  outdatedComponents,
  trackedComponents,
  useUpdateCheck,
  versionReport,
  type ComponentReport,
  type UpdateReport,
  type UpdateState,
} from "@/lib/updates"
import { cn } from "@/lib/utils"

import type { SettingsSectionComponentProps } from "../settings-config"
import { SettingsPanel, SettingsToggle } from "./settings-primitives"

/**
 * The badge, which answers one question: does this need me to do anything?
 *
 * Status only. Where a copy came from - the bundle, your PATH, an environment
 * variable - is not a status, and wearing it as one made two rows that need
 * nothing look like two different kinds of thing. That belongs under the
 * version, where `versionNote` puts it.
 *
 * So `bundled` and `pinned` read the same as `current`: present, working, and
 * nothing known to be newer. They are still separate underneath, because the
 * app can replace one and not the other, and the dialog behind the app's row
 * is built on exactly that difference.
 *
 * Each status owns a colour, and both places it appears - the badge and the
 * box's left edge - are driven from the one entry here. Three tiers rather
 * than a spectrum: green is settled, amber wants you eventually, red is
 * broken now. An update and a missing ffmpeg are deliberately not the same
 * colour, because only one of them has stopped downloads working.
 */
type StatusStyle = {
  label: string
  /** The badge's colour, and the colour of anything explaining it. */
  tone: string
  /** The same colour on the box's left edge, so a row reads at a glance. */
  edge: string
  icon: typeof RiCheckLine
}

/** Present, working, nothing known to be newer - however that was arrived at. */
const SETTLED = {
  label: "Up to date",
  tone: "text-success",
  edge: "border-l-success",
  icon: RiCheckLine,
} satisfies StatusStyle

const STATE_STYLE: Record<UpdateState, StatusStyle> = {
  current: SETTLED,
  bundled: SETTLED,
  pinned: SETTLED,
  outdated: {
    label: "Update available",
    // Amber rather than the app's red: an update is something to get round to,
    // and saying it in the same colour as a missing ffmpeg would make the two
    // look equally urgent when only one of them stops downloads working.
    tone: "text-warning",
    edge: "border-l-warning",
    icon: RiLoopRightLine,
  },
  unavailable: {
    label: "Missing",
    tone: "text-destructive",
    edge: "border-l-destructive",
    icon: RiCloseCircleLine,
  },
  error: {
    label: "Check failed",
    tone: "text-destructive",
    edge: "border-l-destructive",
    icon: RiErrorWarningLine,
  },
  unknown: {
    label: "Unknown",
    tone: "text-muted-foreground",
    edge: "border-l-border",
    icon: RiQuestionLine,
  },
}

/**
 * The line under a version: what it is being measured against.
 *
 * Every row shows a version, and on its own a version answers nothing - the
 * question is always "compared with what". A row with a release to compare
 * against names it; a row with none says why, rather than leaving a number
 * sitting there looking approved.
 */
function versionNote(report: ComponentReport) {
  if (report.latest) {
    return `Latest ${report.latest}`
  }

  switch (report.state) {
    case "pinned":
      return "Your build"
    case "bundled":
      return "With the app"
    case "unavailable":
      return "Not found"
    case "error":
      return "Check failed"
    default:
      return null
  }
}

/**
 * Whether a row's message is worth printing, and in the badge's own colour.
 *
 * The states left out are the settled ones - current, bundled, pinned. Their
 * messages are true but unremarkable ("Shipped with the app."), and printing
 * them under every row would make the two that matter look the same as the
 * five that do not.
 */
function messageTone(state: UpdateState) {
  switch (state) {
    case "outdated":
      return STATE_STYLE.outdated.tone
    case "unavailable":
    case "error":
      return "text-destructive"
    case "unknown":
      return "text-muted-foreground"
    default:
      return null
  }
}

/** The tiny uppercase rule that heads each band of rows. */
function GroupHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-center gap-3 pt-3 pb-1 first:pt-0">
      <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
        {title}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border" />
      {note ? (
        <span className="truncate text-[10px] tracking-widest text-muted-foreground uppercase">
          {note}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The shell every row shares: a one-pixel border with a heavier left edge
 * carrying the row's status colour.
 *
 * The weight is what makes the colour legible - at one pixel a green edge and
 * a grey one are the same edge from a normal viewing distance. The summary
 * band above uses the same pair of widths for the same reason.
 *
 * Shared so the app's row - which is a button, because opening it says what is
 * inside the install - sits on exactly the same line as the rows that are not.
 */
const ROW_SHELL =
  "flex flex-col gap-2 border bg-muted/20 p-3 @xl:flex-row @xl:items-center @xl:gap-4"

/** Everything in a row except what it does when you press it. */
function RowBody({ report }: { report: ComponentReport }) {
  const style = STATE_STYLE[report.state]
  const Icon = style.icon
  const note = versionNote(report)
  const tone = messageTone(report.state)

  return (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{report.name}</span>
          <Badge className={style.tone}>
            <Icon data-icon="inline-start" />
            {style.label}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{report.purpose}</p>

        {/* The reason, but only where there is one worth reading. A settled
            row explains nothing beyond its badge; a row that is behind, gone
            or unanswered is the whole reason somebody opened this screen. */}
        {tone && report.message ? (
          <p className={cn("mt-1 text-xs", tone)}>{report.message}</p>
        ) : null}
      </div>

      <div className="shrink-0 @xl:w-36 @xl:text-right">
        <div
          className={cn(
            "truncate font-mono text-xs",
            !report.current && "text-muted-foreground"
          )}
          title={report.current ?? undefined}
        >
          {report.current ?? "no version"}
        </div>
        {note ? (
          <div
            className={cn(
              "truncate text-[10px] tracking-widest text-muted-foreground uppercase",
              report.state === "outdated" && style.tone
            )}
          >
            {note}
          </div>
        ) : null}
      </div>
    </>
  )
}

/** One component: what it is, what version it is, and what to do about it. */
function ComponentRow({ report }: { report: ComponentReport }) {
  // Bound here so each handler closes over a string rather than a property
  // TypeScript cannot promise is still there when it runs.
  const releases = report.url
  const location = report.path

  return (
    <div className={cn(ROW_SHELL, STATE_STYLE[report.state].edge)}>
      <RowBody report={report} />

      {/* One action, as an icon. The left column is narrow once the panel
          splits in two, and a labelled button here cost more width than the
          version it sat beside - which is the thing somebody came to read. */}
      <div className="flex shrink-0 items-center justify-end">
        {releases ? (
          <RowAction
            label={`Open ${report.name} releases`}
            icon={RiExternalLinkLine}
            onClick={() => {
              void openUrl(releases).catch((error: unknown) => {
                toast.error(describeError(error))
              })
            }}
          />
        ) : location ? (
          <RowAction
            label={`Show ${report.name} in the file manager`}
            icon={RiFolderOpenLine}
            onClick={() => {
              void revealPath(location).catch((error: unknown) => {
                toast.error(describeError(error))
              })
            }}
          />
        ) : (
          // A placeholder, so the version column lines up down the list
          // whether or not a row has anything to press.
          <span aria-hidden className="size-7" />
        )}
      </div>
    </div>
  )
}

/**
 * The app's row, which opens onto what is sealed inside it.
 *
 * The whole row is the trigger rather than an icon at the end of it: the app
 * *is* its dependencies, so "what am I running" is the natural second question
 * about this row and not a separate feature hiding behind a control.
 *
 * A `<button>` for that reason, which is also why the release link moved into
 * the dialog - a button inside a button is not a thing, and burying the link
 * one press deeper costs nothing next to making the row itself pressable.
 */
function AppRow({
  report,
  inside,
}: {
  report: ComponentReport
  inside: ComponentReport[]
}) {
  const releases = report.url

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            className={cn(
              ROW_SHELL,
              STATE_STYLE[report.state].edge,
              "w-full cursor-pointer text-left transition-colors outline-none",
              "hover:bg-muted/40 focus-visible:bg-muted/40"
            )}
          />
        }
      >
        <RowBody report={report} />
        <div className="flex shrink-0 items-center justify-end">
          <RiArrowRightSLine
            aria-hidden
            className="size-4 text-muted-foreground"
          />
        </div>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Inside {report.name}</DialogTitle>
          <DialogDescription>
            The app and everything sealed into this install. None of it updates
            on its own - all of it moves when the app does.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto">
          <InsideRow report={report} />
          {inside.length > 0 ? (
            inside.map((entry) => <InsideRow key={entry.id} report={entry} />)
          ) : (
            <p className="py-2 text-xs text-muted-foreground">
              Nothing else could be read. The service reports what is bundled,
              and it is not running.
            </p>
          )}
        </div>

        <DialogFooter>
          {releases ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void openUrl(releases).catch((error: unknown) => {
                  toast.error(describeError(error))
                })
              }}
            >
              <RiExternalLinkLine
                data-icon="inline-start"
                className="size-3.5"
              />
              Releases
            </Button>
          ) : null}
          <DialogClose
            render={
              <Button variant="secondary" size="sm">
                Close
              </Button>
            }
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One line of the "what is inside" list: name, what it is, what version. */
function InsideRow({ report }: { report: ComponentReport }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="font-mono text-xs font-medium">{report.name}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{report.purpose}</p>
      </div>
      <div className="shrink-0 text-right">
        <div
          className={cn(
            "font-mono text-xs",
            !report.current && "text-muted-foreground"
          )}
        >
          {report.current ?? "no version"}
        </div>
        {report.latest ? (
          <div
            className={cn(
              "text-[10px] tracking-widest text-muted-foreground uppercase",
              report.state === "outdated" && STATE_STYLE.outdated.tone
            )}
          >
            Latest {report.latest}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** An icon-sized row action that says what it is on hover. */
function RowAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string
  icon: typeof RiCheckLine
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
          >
            <Icon />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A number over its label, for the band at the top. */
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0">
      <div className="font-heading text-lg leading-none font-semibold">
        {value}
      </div>
      <div className="mt-1 text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </div>
    </div>
  )
}

/** The whole install in one sentence, plus the counts behind it. */
function Summary({ report }: { report: UpdateReport | null }) {
  const behind = outdatedComponents(report)
  const missing = missingComponents(report)
  const failed = failedComponents(report)
  const bundled = bundledComponents(report)
  const tracked = report?.components.filter((entry) => entry.latest) ?? []

  // Ordered by what somebody would want to be told first: a missing ffmpeg
  // breaks downloads today, where an available update does not.
  const headline = !report
    ? "Nothing has been checked yet."
    : missing.length > 0
      ? `${missing.map((entry) => entry.name).join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`
      : behind.length > 0
        ? `${behind.map((entry) => entry.name).join(", ")} ${behind.length === 1 ? "has" : "have"} a newer release.`
        : "Everything is current."

  const detail = !report
    ? "Run a check to see the app and everything it ships with."
    : failed.length > 0
      ? (failed[0].message ?? "Some checks could not complete.")
      : behind.length > 0
        ? "Updating the app brings everything sealed inside it along too."
        : "Nothing is behind."

  // The band wears the worst status on the screen, in the same colours the
  // rows below it use, so the top of the page and the row it is about are
  // never two different-looking claims about one install.
  const status = !report
    ? STATE_STYLE.unknown
    : missing.length > 0
      ? STATE_STYLE.unavailable
      : behind.length > 0
        ? STATE_STYLE.outdated
        : STATE_STYLE.current

  const Icon = report ? status.icon : RiQuestionLine

  return (
    <div
      className={cn(
        "flex flex-col gap-4 border bg-muted/20 p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between",
        status.edge
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            report ? status.tone : "text-muted-foreground"
          )}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium">{headline}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>

      {report ? (
        <div className="flex shrink-0 gap-6 border-t pt-3 @2xl:border-t-0 @2xl:border-l @2xl:pt-0 @2xl:pl-6">
          <Stat value={report.components.length} label="Components" />
          <Stat value={tracked.length} label="Tracked" />
          <Stat value={bundled.length} label="With the app" />
        </div>
      ) : null}
    </div>
  )
}

/** One switch with its own explanation, for the narrow right-hand column. */
function PreferenceToggle({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="pt-0.5">
        <SettingsToggle
          label={label}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

/** A bordered block in the right-hand column, with a small heading. */
function SidePanel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="border bg-muted/20">
      <header className="border-b p-3">
        <h3 className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
          {title}
        </h3>
      </header>
      <div className="flex flex-col gap-4 p-3">{children}</div>
    </section>
  )
}

/** What the feed field will actually be asked for, in words. */
function describeFeedTarget(feed: string) {
  const target = describeFeed(feed)

  switch (target.kind) {
    case "github":
      return target.builtIn
        ? `Reads releases from ${target.repo}, the feed this build ships with.`
        : `Reads releases from the ${target.repo} repository on GitHub.`
    case "json":
      return "Reads a JSON manifest, in Tauri's updater shape."
  }
}

export function UpdatesSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  const preferences = config.updates
  const { report, checking } = useUpdateCheck()

  // "4 minutes ago" stops being true while somebody reads it, so the line is
  // re-rendered on a slow tick rather than only when the report changes.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000)

    return () => clearInterval(timer)
  }, [])

  const tracked = trackedComponents(report)
  const bundled = bundledComponents(report)
  const app = tracked.filter((entry) => entry.id === "app")
  const external = tracked.filter((entry) => entry.id !== "app")

  const runCheck = () => {
    void checkForUpdates(preferences)
      .then((result) => {
        const behind = outdatedComponents(result)
        const failed = failedComponents(result)

        if (behind.length > 0) {
          toast.info(
            behind.length === 1
              ? `${behind[0].name} has an update available`
              : `${behind.length} components have updates available`
          )

          return
        }

        // A failure is worth saying out loud on a check somebody asked for -
        // otherwise a rate-limited GitHub looks exactly like good news.
        if (failed.length > 0) {
          toast.warning("Some checks could not complete", {
            description: failed[0].message ?? undefined,
          })

          return
        }

        toast.success("Everything is up to date")
      })
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : "The check could not run."
        )
      })
  }

  const copyReport = () => {
    if (!report) {
      return
    }

    void navigator.clipboard
      .writeText(versionReport(report, describeFeed(preferences.feedUrl)))
      .then(() =>
        toast.success("Version report copied", {
          description: "JSON, ready to paste into an issue.",
        })
      )
      .catch(() => toast.error("Could not copy to the clipboard."))
  }

  return (
    <SettingsPanel
      bare
      title="Updates"
      description="What this install is made of, and whether any of it is behind."
      actions={
        <>
          {report ? (
            <span className="text-[10px] tracking-widest text-muted-foreground uppercase">
              Checked {describeAge(report.checkedAt)}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={runCheck}
            disabled={checking}
          >
            {checking ? (
              <Spinner className="size-3.5" />
            ) : (
              <RiRefreshLine data-icon="inline-start" className="size-3.5" />
            )}
            {checking ? "Checking" : "Check now"}
          </Button>
        </>
      }
    >
      {/* Container queries, not viewport ones: this pane shares the window
          with the app rail and the settings nav, so the viewport says almost
          nothing about how much room there is here. */}
      <div className="@container flex flex-col gap-4">
        <Summary report={report} />

        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:items-start">
          <div className="flex min-w-0 flex-col gap-2">
            {report ? (
              <>
                <GroupHeading
                  title="The app"
                  note={
                    app[0]?.latest
                      ? "Checked against its release feed"
                      : "No release found yet"
                  }
                />
                {app.map((entry) => (
                  <AppRow key={entry.id} report={entry} inside={bundled} />
                ))}

                {external.length > 0 ? (
                  <>
                    <GroupHeading
                      title="Tracked separately"
                      note="Checked on its own"
                    />
                    {external.map((entry) => (
                      <ComponentRow key={entry.id} report={entry} />
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <div className="border bg-muted/20 p-3 text-xs text-muted-foreground">
                The app, the download service, yt-dlp, ffmpeg, ffprobe, the JS
                runtime and Python are all checked together. Open the app&apos;s
                row afterwards to see everything sealed inside it.
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {/* "Checking", not "When to check": one of these two is about
                when, and the other about what happens afterwards. */}
            <SidePanel title="Checking">
              <PreferenceToggle
                label="Check on launch"
                description="Runs a check shortly after the app opens, once the service is up."
                checked={preferences.checkOnLaunch}
                onCheckedChange={(checkOnLaunch) =>
                  updateConfig((current) => ({
                    ...current,
                    updates: { ...current.updates, checkOnLaunch },
                  }))
                }
              />

              <PreferenceToggle
                label="Notify on findings"
                description="Only when a check finds something - a clean check stays quiet."
                checked={preferences.notify}
                onCheckedChange={(notify) =>
                  updateConfig((current) => ({
                    ...current,
                    updates: { ...current.updates, notify },
                  }))
                }
              />
            </SidePanel>

            <SidePanel title="Release feed">
              <p className="text-xs text-muted-foreground">
                Where the app&apos;s own releases are read from. Left empty it
                uses the one this build ships with - set it only to follow a
                fork, or your own manifest.
              </p>

              <Input
                id="updates-feed-url"
                value={preferences.feedUrl}
                placeholder={DEFAULT_APP_REPO}
                onChange={(event) =>
                  updateConfig((current) => ({
                    ...current,
                    updates: {
                      ...current.updates,
                      feedUrl: event.target.value,
                    },
                  }))
                }
              />

              <p className="text-xs text-muted-foreground">
                {describeFeedTarget(preferences.feedUrl)}
              </p>
            </SidePanel>

            {report ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={copyReport}
              >
                <RiFileCopyLine data-icon="inline-start" className="size-3.5" />
                Copy version report
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </SettingsPanel>
  )
}
