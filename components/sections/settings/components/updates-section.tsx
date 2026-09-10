"use client"

import { useEffect, useState } from "react"

import {
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiDownloadCloud2Line,
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
import {
  RowContextMenu,
  type RowAction as MenuAction,
} from "@/components/sections/downloads/row-menu"
import { describeError, openUrl, revealPath } from "@/lib/inferno-service"
import {
  checkForUpdates,
  componentsInGroup,
  DEFAULT_APP_REPO,
  describeAge,
  describeFeed,
  displayComponents,
  useUpdateCheck,
  versionReport,
  type ComponentReport,
  type UpdatePreferences,
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

/** Copy something small, and say so. Shared by the row and its menu. */
function copyToClipboard(label: string, value: string) {
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copied`))
    .catch(() => toast.error("Could not copy to the clipboard."))
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
 * The shell every row shares: an even border, with the left edge coloured by
 * the row's status.
 *
 * Even on all four sides, so the boxes stack flush and colour alone carries
 * the status. The summary band above is built the same way, so the two read as
 * one set rather than as a heading and a list drawn by different hands.
 *
 * Shared so the app's row - which is a button, because opening it says what is
 * inside the install - sits on exactly the same line as the rows that are not.
 */
const ROW_SHELL =
  "flex flex-col gap-2 border border-l bg-muted/20 p-3 transition-colors @xl:flex-row @xl:items-center @xl:gap-4"

/**
 * What a row being checked looks like: the shell itself lit slightly.
 *
 * The loading state is the background rather than a bar or a shimmer, because
 * several rows can be checking at once now and a list of animations racing each
 * other reads as a fault. A tint says the same thing quietly, and being a
 * colour it costs no layout - which is the whole point, since the row must not
 * move while it waits.
 */
const ROW_BUSY = "bg-foreground/10"

/**
 * Everything in a row except what it does when you press it.
 *
 * `busy` is this row's own answer still being fetched, not the check as a
 * whole: the app's release, the service's health and yt-dlp's release all
 * land at different moments, so each row stops spinning when *it* is known
 * rather than when the last of them is.
 */
function RowBody({
  report,
  busy,
  restoring,
}: {
  report: ComponentReport
  busy?: boolean
  /** A repair is running for this row - looking for a spare, or fetching one. */
  restoring?: boolean
}) {
  const style = STATE_STYLE[report.state]
  const Icon = style.icon
  const note = versionNote(report)
  const tone = messageTone(report.state)

  return (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{report.name}</span>
          {/* A repair outranks everything else the badge could say. "Missing"
              is still true while one runs, but it is the least useful true
              thing available - it describes the problem to somebody who can
              already see the app solving it. */}
          {restoring ? (
            // Amber, not red. Red is for something broken and left that way;
            // a file being fetched is on its way to fine, which is the same
            // "wants a moment, needs nothing from you" the outdated rows wear.
            //
            // No percentage, and nothing drawn behind the row. ffmpeg and
            // ffprobe come out of one archive, so a repair for both is one
            // transfer with one number - and the same number behind two rows
            // drew a pair of bars moving in lockstep, which read as a bug
            // rather than as a download. The word is the whole status.
            <Badge className="text-warning">
              <RiDownloadCloud2Line data-icon="inline-start" />
              Downloading
            </Badge>
          ) : busy ? (
            <Badge variant="ghost">
              <Spinner data-icon="inline-start" className="size-3" />
              Checking
            </Badge>
          ) : (
            <Badge className={style.tone}>
              <Icon data-icon="inline-start" />
              {style.label}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{report.purpose}</p>

        {/* The reason, but only where there is one worth reading. A settled
            row explains nothing beyond its badge; a row that is behind, gone
            or unanswered is the whole reason somebody opened this screen.
            Kept on screen while the row is re-checked rather than hidden:
            taking it away shrinks the row, and putting it back a second later
            grows it again, which shuffles everything underneath twice for no
            information at all. */}
        {tone && report.message ? (
          <p
            className={cn(
              "mt-1 text-xs transition-opacity",
              tone,
              busy && "opacity-40"
            )}
          >
            {report.message}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "min-w-0 shrink-0 transition-opacity @xl:w-52 @xl:text-right",
          // The previous answer stays put while it is re-checked - dimmed, so
          // it reads as "this is what it was" rather than as fresh.
          busy && "opacity-40"
        )}
      >
        {/* One line, always. A version that wrapped moved every row below it
            about, which costs more than the tail of an ffmpeg build string is
            worth - and the full value is on the tooltip and one menu item
            away. */}
        <div
          className={cn(
            "truncate font-mono text-xs",
            !report.current && "text-muted-foreground"
          )}
          title={report.current ?? undefined}
        >
          {report.current ?? "no version"}
        </div>

        {/* Underneath: the digest of the file itself where there is one, and
            otherwise what the version is being measured against. The hash wins
            because it is the more specific answer - two builds can share a
            version string and not a byte. */}
        {report.hash ? (
          <span
            // A span, not a button: the app's row *is* a button, and although
            // it never carries a hash today, nesting one inside it would be
            // invalid the moment it did. The same copy is on the row's menu,
            // which is the keyboard-reachable half of this.
            role="button"
            tabIndex={-1}
            title={`sha256:${report.hash}\nClick to copy`}
            onClick={(event) => {
              // The app's row opens a dialog on click; copying a digest is not
              // a request to do that as well.
              event.stopPropagation()
              copyToClipboard("Digest", report.hash ?? "")
            }}
            className="block cursor-pointer truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {report.hash.slice(0, 16)}
          </span>
        ) : note ? (
          <div
            className={cn(
              "text-[10px] tracking-widest text-muted-foreground uppercase",
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

/**
 * What right-clicking a row offers.
 *
 * Re-checking one component is the point of it: the whole-screen button asks
 * everything, which on a slow feed means waiting on GitHub to find out whether
 * ffmpeg is still where it was. Narrowed to one row it is a single question,
 * and for a binary it is the one piece of real work in the check - the file
 * gets read end to end again.
 */
function buildRowActions(
  report: ComponentReport,
  preferences: UpdatePreferences
) {
  const groups: MenuAction[][] = [
    [
      {
        label: "Check for updates",
        hint: `Re-check ${report.name} on its own`,
        icon: RiRefreshLine,
        run: () => {
          void checkForUpdates(preferences, { only: [report.id] }).catch(
            () => {}
          )
        },
      },
      // No "restore" entry. A missing file repairs itself the moment a check
      // finds it, and every check tries again - so an item to ask for it by
      // hand would only ever duplicate what has already happened.
    ],
    [
      {
        label: "Copy version",
        hint: report.current ?? "This one did not report a version",
        icon: RiFileCopyLine,
        disabled: !report.current,
        run: () => copyToClipboard("Version", report.current ?? ""),
      },
      ...(report.hash
        ? [
            {
              label: "Copy SHA-256",
              hint: report.hash,
              icon: RiFileCopyLine,
              run: () => copyToClipboard("Digest", report.hash ?? ""),
            },
          ]
        : []),
    ],
    [
      ...(report.url
        ? [
            {
              label: "Open releases",
              icon: RiExternalLinkLine,
              run: () => {
                void openUrl(report.url ?? "").catch((error: unknown) => {
                  toast.error(describeError(error))
                })
              },
            },
          ]
        : []),
      ...(report.path
        ? [
            {
              label: "Show in folder",
              hint: report.path,
              icon: RiFolderOpenLine,
              run: () => {
                void revealPath(report.path ?? "").catch((error: unknown) => {
                  toast.error(describeError(error))
                })
              },
            },
          ]
        : []),
    ],
  ]

  return groups
}

/** One component: what it is, what version it is, and what to do about it. */
function ComponentRow({
  report,
  busy,
  restoring,
  preferences,
}: {
  report: ComponentReport
  busy?: boolean
  restoring?: boolean
  preferences: UpdatePreferences
}) {
  // Bound here so each handler closes over a string rather than a property
  // TypeScript cannot promise is still there when it runs.
  const releases = report.url
  const location = report.path
  const groups = buildRowActions(report, preferences)

  return (
    <RowContextMenu groups={groups}>
      <div
        className={cn(
          ROW_SHELL,
          // A row being re-checked has no status yet, so it wears none; one
          // being put back wears the amber its badge does.
          restoring
            ? "border-l-warning"
            : busy
              ? cn("border-l-border", ROW_BUSY)
              : STATE_STYLE[report.state].edge
        )}
      >
        <RowBody report={report} busy={busy} restoring={restoring} />

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
    </RowContextMenu>
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
  busy,
  restoring,
  preferences,
}: {
  report: ComponentReport
  inside: ComponentReport[]
  busy?: boolean
  restoring?: boolean
  preferences: UpdatePreferences
}) {
  const releases = report.url
  const groups = buildRowActions(report, preferences)

  return (
    <Dialog>
      {/* The row answers to both a left and a right click: opening it says
          what is inside the install, and the menu re-checks just this one.
          Composed rather than nested, so there is still exactly one element
          in the list where a person sees one row. */}
      <RowContextMenu groups={groups}>
        <DialogTrigger
          render={
            <button
              type="button"
              className={cn(
                ROW_SHELL,
                restoring
                  ? "border-l-warning"
                  : busy
                    ? cn("border-l-border", ROW_BUSY)
                    : STATE_STYLE[report.state].edge,
                "w-full cursor-pointer text-left outline-none",
                "hover:bg-muted/40 focus-visible:bg-muted/40"
              )}
            />
          }
        >
          <RowBody report={report} busy={busy} restoring={restoring} />
          <div className="flex shrink-0 items-center justify-end">
            <RiArrowRightSLine
              aria-hidden
              className="size-4 text-muted-foreground"
            />
          </div>
        </DialogTrigger>
      </RowContextMenu>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Inside {report.name}</DialogTitle>
          <DialogDescription>
            The app and its own working parts - the download service, the yt-dlp
            inside it, the Python it is built on. None of them update on their
            own; all of them move when the app does.
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

/**
 * The whole install in one sentence, plus the counts behind it.
 *
 * Counted over the rows on screen rather than over the whole check. The band
 * has to be a summary of the list beneath it - naming something in the
 * headline that has no row to look at would send somebody hunting for a thing
 * this screen deliberately does not list.
 */
function Summary({
  report,
  checking,
}: {
  report: UpdateReport | null
  checking: boolean
}) {
  // Padded to the full roster whether or not anything has been checked, so
  // the counts below occupy the same space before and after a check.
  const shown = displayComponents(report)
  const behind = shown.filter((entry) => entry.state === "outdated")
  const missing = shown.filter((entry) => entry.state === "unavailable")
  const failed = shown.filter((entry) => entry.state === "error")
  const bundled = shown.filter((entry) => entry.state === "bundled")
  const tracked = shown.filter((entry) => entry.latest)

  // Ordered by what somebody would want to be told first: a missing ffmpeg
  // breaks downloads today, where an available update does not.
  const headline = !report
    ? checking
      ? "Checking this install."
      : "Nothing has been checked yet."
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
        "flex flex-col gap-4 border border-l bg-muted/20 p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between",
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

      {/* Present from the moment a check starts, so the band does not grow a
          column of numbers halfway through one. */}
      {report || checking ? (
        <div className="flex shrink-0 gap-6 border-t pt-3 @2xl:border-t-0 @2xl:border-l @2xl:pt-0 @2xl:pl-6">
          <Stat value={shown.length} label="Components" />
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
  const { report, checking, pending, repairing } = useUpdateCheck()

  // "4 minutes ago" stops being true while somebody reads it, so the line is
  // re-rendered on a slow tick rather than only when the report changes.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000)

    return () => clearInterval(timer)
  }, [])

  const isPending = (entry: ComponentReport) => pending.includes(entry.id)

  // Split by where a thing came from, not by what the check made of it. The
  // list out here is somebody else's software shipped beside the app; the
  // app's own parts - its service, the yt-dlp in it, the Python it is frozen
  // with - are what opening the app's row shows. Provenance does not change
  // with an answer, so nothing moves between the two mid-check.
  const app = componentsInGroup(report, "app")
  const external = componentsInGroup(report, "vendor")
  const inside = componentsInGroup(report, "inside")

  const runCheck = () => {
    void checkForUpdates(preferences)
      .then((result) => {
        // The same set the screen lists, so a toast never names a row that is
        // not there to be looked at.
        const settled = displayComponents(result)
        const behind = settled.filter((entry) => entry.state === "outdated")
        const failed = settled.filter((entry) => entry.state === "error")

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
        <Summary report={report} checking={checking} />

        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:items-start">
          <div className="flex min-w-0 flex-col gap-2">
            {/* Drawn as soon as a check starts, not only once it finishes -
                the roster is known in advance, so the first check on a fresh
                install has real rows to put its spinners on. */}
            {report || checking ? (
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
                  <AppRow
                    key={entry.id}
                    report={entry}
                    inside={inside}
                    busy={isPending(entry)}
                    restoring={repairing.includes(entry.id)}
                    preferences={preferences}
                  />
                ))}

                {external.length > 0 ? (
                  <>
                    <GroupHeading
                      title="Alongside the app"
                      note="Third-party, shipped with it"
                    />
                    {external.map((entry) => (
                      <ComponentRow
                        key={entry.id}
                        report={entry}
                        busy={isPending(entry)}
                        restoring={repairing.includes(entry.id)}
                        preferences={preferences}
                      />
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <div className="border bg-muted/20 p-3 text-xs text-muted-foreground">
                The app, the download service and the media tools it ships are
                all checked together. Open the app&apos;s row afterwards to see
                everything sealed inside it.
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
