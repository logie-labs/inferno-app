"use client"

import { useEffect, useState } from "react"

import {
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiFolderOpenLine,
  RiLoopRightLine,
  RiPushpinLine,
  RiQuestionLine,
  RiRefreshLine,
  RiRssLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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

import type {
  SettingsConfig,
  SettingsSectionComponentProps,
} from "../settings-config"
import { SettingsPanel, SettingsToggle } from "./settings-primitives"

/**
 * How each state is worn.
 *
 * `current` and `pinned` are deliberately quiet. The point of the screen is
 * that the row needing attention is the one you see first, and a column of
 * ticks would bury it - so only trouble is coloured.
 */
const STATE_STYLE: Record<
  UpdateState,
  {
    label: string
    variant: "default" | "secondary" | "destructive" | "ghost"
    className?: string
    icon: typeof RiCheckLine
  }
> = {
  current: { label: "Up to date", variant: "secondary", icon: RiCheckLine },
  outdated: {
    label: "Update available",
    variant: "default",
    className: "text-primary",
    icon: RiLoopRightLine,
  },
  bundled: { label: "Bundled", variant: "secondary", icon: RiCheckLine },
  pinned: { label: "Pinned", variant: "ghost", icon: RiPushpinLine },
  unavailable: {
    label: "Missing",
    variant: "destructive",
    icon: RiCloseCircleLine,
  },
  unknown: { label: "Unknown", variant: "ghost", icon: RiQuestionLine },
  unconfigured: {
    label: "Not checked",
    variant: "ghost",
    icon: RiQuestionLine,
  },
  error: {
    label: "Check failed",
    variant: "destructive",
    icon: RiErrorWarningLine,
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
    case "unconfigured":
      return "No feed set"
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

/** One component: what it is, what version it is, and what to do about it. */
function ComponentRow({
  report,
  onSetFeed,
}: {
  report: ComponentReport
  onSetFeed?: () => void
}) {
  const style = STATE_STYLE[report.state]
  const Icon = style.icon
  const note = versionNote(report)
  // Bound here so each handler closes over a string rather than a property
  // TypeScript cannot promise is still there when it runs.
  const releases = report.url
  const location = report.path

  return (
    <div
      className={cn(
        "flex flex-col gap-2 border border-l-2 bg-muted/20 p-3 @xl:flex-row @xl:items-center @xl:gap-4",
        // The one row that needs somebody is the one wearing the accent.
        report.state === "outdated"
          ? "border-l-primary"
          : report.state === "unavailable" || report.state === "error"
            ? "border-l-destructive"
            : "border-l-border"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{report.name}</span>
          <Badge variant={style.variant} className={style.className}>
            <Icon data-icon="inline-start" />
            {style.label}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{report.purpose}</p>
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
              report.state === "outdated" && "text-primary"
            )}
          >
            {note}
          </div>
        ) : null}
      </div>

      {/* One action, as an icon. The left column is narrow once the panel
          splits in two, and a labelled button here cost more width than the
          version it sat beside - which is the thing somebody came to read. */}
      <div className="flex shrink-0 items-center justify-end">
        {onSetFeed ? (
          <RowAction label="Set the release feed" icon={RiRssLine} onClick={onSetFeed} />
        ) : releases ? (
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
  const trouble = missing.length > 0 || behind.length > 0
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

  const Icon = trouble
    ? missing.length > 0
      ? RiCloseCircleLine
      : RiLoopRightLine
    : RiCheckLine

  return (
    <div
      className={cn(
        "flex flex-col gap-4 border border-l-2 bg-muted/20 p-4 @2xl:flex-row @2xl:items-center @2xl:justify-between",
        missing.length > 0
          ? "border-l-destructive"
          : behind.length > 0
            ? "border-l-primary"
            : "border-l-border"
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            trouble ? "text-primary" : "text-muted-foreground"
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
    <section className="border border-l-2 border-l-border bg-muted/20">
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
    case "none":
      return "The app's own version is not being checked."
    case "github":
      return `Reads releases from the ${target.repo} repository on GitHub.`
    case "json":
      return "Reads a JSON manifest, in Tauri's updater shape."
  }
}

const FREQUENCIES: Array<{
  value: SettingsConfig["updates"]["frequency"]
  label: string
}> = [
  { value: "never", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
]

export function UpdatesSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  const preferences = config.updates
  const { report, checking } = useUpdateCheck()

  // The bundled rows fold away because not one of them can be acted on: they
  // arrive with the app and leave with it. Kept collapsed rather than dropped,
  // because "what am I actually running" is a real question - just not the one
  // this screen is for.
  const [showBundled, setShowBundled] = useState(false)

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

  const focusFeed = () => {
    const field = document.getElementById("updates-feed-url")

    if (field instanceof HTMLInputElement) {
      field.scrollIntoView({ block: "center", behavior: "smooth" })
      field.focus()
    }
  }

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
      .writeText(versionReport(report))
      .then(() => toast.success("Version report copied"))
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
                      : "Not being checked"
                  }
                />
                {app.map((entry) => (
                  <ComponentRow
                    key={entry.id}
                    report={entry}
                    onSetFeed={
                      entry.state === "unconfigured" ? focusFeed : undefined
                    }
                  />
                ))}

                {external.length > 0 ? (
                  <>
                    <GroupHeading
                      title="Tracked separately"
                      note="Updates on its own schedule"
                    />
                    {external.map((entry) => (
                      <ComponentRow key={entry.id} report={entry} />
                    ))}
                  </>
                ) : null}

                {bundled.length > 0 ? (
                  <Collapsible
                    open={showBundled}
                    onOpenChange={setShowBundled}
                    className="mt-1"
                  >
                    <CollapsibleTrigger
                      render={
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 border bg-muted/20 p-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
                        />
                      }
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          Sealed inside the app
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {bundled.length} components that arrive and leave with
                          the app. Nothing here can be updated on its own.
                        </span>
                      </span>
                      <RiArrowDownSLine
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                          showBundled && "rotate-180"
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="flex flex-col gap-2 pt-2">
                      {bundled.map((entry) => (
                        <ComponentRow key={entry.id} report={entry} />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </>
            ) : (
              <div className="border bg-muted/20 p-3 text-xs text-muted-foreground">
                The app, the download service, yt-dlp, ffmpeg, ffprobe, the JS
                runtime and Python are all checked together. Anything the app
                ships is folded away - updating the app updates all of it.
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <SidePanel title="When to check">
              <div>
                <div className="mb-2 text-sm font-medium">Automatically</div>
                <ButtonGroup className="w-full">
                  {FREQUENCIES.map((option) => (
                    <Button
                      key={option.value}
                      variant={
                        preferences.frequency === option.value
                          ? "secondary"
                          : "outline"
                      }
                      size="sm"
                      className="flex-1"
                      aria-pressed={preferences.frequency === option.value}
                      onClick={() =>
                        updateConfig((current) => ({
                          ...current,
                          updates: {
                            ...current.updates,
                            frequency: option.value,
                          },
                        }))
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </ButtonGroup>
                <p className="mt-2 text-xs text-muted-foreground">
                  How often to check again while the app stays open.
                </p>
              </div>

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
                label="Track yt-dlp releases"
                description="Compares the bundled yt-dlp with its own latest release. It is the one that explains most downloads that stop working."
                checked={preferences.includeTools}
                onCheckedChange={(includeTools) =>
                  updateConfig((current) => ({
                    ...current,
                    updates: { ...current.updates, includeTools },
                  }))
                }
              />

              <PreferenceToggle
                label="Include pre-releases"
                description="Counts beta and nightly builds as available updates."
                checked={preferences.includePrereleases}
                onCheckedChange={(includePrereleases) =>
                  updateConfig((current) => ({
                    ...current,
                    updates: { ...current.updates, includePrereleases },
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
                Where this app&apos;s own releases are published. Left empty,
                the app stays unchecked rather than being reported as current.
              </p>

              <Input
                id="updates-feed-url"
                value={preferences.feedUrl}
                placeholder="owner/repo, or a manifest URL"
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

              <p
                className={cn(
                  "flex items-start gap-1.5 text-xs",
                  describeFeed(preferences.feedUrl).kind === "none"
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
              >
                {describeFeed(preferences.feedUrl).kind === "none" ? (
                  <RiErrorWarningLine className="mt-px size-3.5 shrink-0" />
                ) : null}
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
