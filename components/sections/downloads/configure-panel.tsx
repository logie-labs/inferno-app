"use client"

import {
  RiAlertLine,
  RiArrowDownSLine,
  RiDownloadLine,
  RiMusicLine,
  RiSettings3Line,
  RiVideoLine,
} from "@remixicon/react"

import { useState, type ComponentProps, type ReactNode } from "react"

import { useActiveSection } from "@/components/sections/active-section-context"
import { requestSettingsSection } from "@/components/sections/settings/settings-navigation"

import { RowContextMenu, type RowAction } from "./row-menu"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FolderField } from "@/components/ui/folder-field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSettingsConfig } from "@/components/sections/settings/settings-config"
import { formatBytes } from "@/lib/format"
import { spotifyDeliveryReady, spotifyFormatProblem } from "@/lib/spotify"
import { cn } from "@/lib/utils"

import {
  labelFor,
  optionGroups,
  valueOf,
  withValue,
  type ConfigureMode,
  type DownloadOptions,
  type OptionChoice,
  type OptionGroup,
} from "./download-options"
import type { Preview } from "./preview"
import { VideoSummary } from "./video-summary"

export type { ConfigureMode }

/**
 * One choice.
 *
 * The description lives in the item, not in the trigger: `SelectValue` is given
 * explicit children below, which overrides the selected item's own content, so
 * the closed control shows the label alone.
 */
function ChoiceItem({ choice }: { choice: OptionChoice }) {
  return (
    <SelectItem value={choice.value}>
      <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          {choice.label}
          {choice.recommended ? (
            <Badge className="px-1 py-0 font-mono text-[8px] tracking-[0.12em] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
              Recommended
            </Badge>
          ) : null}
        </span>
        {choice.desc ? (
          <span className="font-mono text-[9.5px] tracking-[0.04em] text-muted-foreground">
            {choice.desc}
          </span>
        ) : null}
      </span>
    </SelectItem>
  )
}

/**
 * A labelled `Select`.
 *
 * The canvas listed the pinned picks and then repeated them inside the full
 * list. A `Select` keys its items by value, so the same value twice reads as
 * two selected rows - the pinned ones are therefore shown once, at the top,
 * and the rest follow under a rule.
 */
/**
 * One concern, boxed.
 *
 * The panel was a single column of labelled controls with nothing to say
 * where one thing ended and the next began - resolution, subtitles, metadata
 * and the folder all read as one long list. The box is the settings screen's
 * box, so the two places look like they are describing the same options.
 */
function PanelSection({
  title,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  /** A heading for the box, not the `title` tooltip a div would take. */
  title?: string
  children: ReactNode
}) {
  return (
    // Spreads what it is given, so a section can be a context-menu trigger
    // without a wrapper element being pushed into the column's flex layout.
    <div
      className={cn("flex flex-col gap-3 border bg-muted/20 p-3", className)}
      {...props}
    >
      {title ? (
        <span className="font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
          {title}
        </span>
      ) : null}
      {children}
    </div>
  )
}

function ConfigDropdown({
  group,
  value,
  onChange,
  hideLabel = false,
}: {
  group: OptionGroup
  value: string
  onChange: (value: string) => void
  /** For when something above the dropdown has already named it. */
  hideLabel?: boolean
}) {
  const pinned = group.pinned
    .map((key) => group.choices.find((choice) => choice.value === key))
    .filter((choice): choice is OptionChoice => Boolean(choice))

  const rest = group.choices.filter(
    (choice) => !group.pinned.includes(choice.value)
  )

  return (
    <div className="flex flex-col gap-2">
      {hideLabel ? null : (
        <span className="font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
          {group.label}
        </span>
      )}

      <Select
        value={value}
        // Base UI reports `null` when a selection is cleared; this control
        // always has a value, so that is simply not a change worth making.
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next)
          }
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full text-[13px] font-medium"
          aria-label={group.label}
        >
          {/* Children override the selected item's text, keeping the
              description out of the closed trigger. */}
          <SelectValue>{labelFor(group, value)}</SelectValue>
        </SelectTrigger>

        {/* Aligned to the trigger rather than to the selected item, so a long
            list does not open with its middle over the control. The popup's
            own scrollbar is hidden - Base UI's scroll arrows appear at
            whichever edge still has items, which is the affordance here. */}
        <SelectContent alignItemWithTrigger={false} className="max-h-72">
          <SelectGroup>
            {pinned.map((choice) => (
              <ChoiceItem key={choice.value} choice={choice} />
            ))}
          </SelectGroup>

          {rest.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel className="font-mono text-[9px] tracking-[0.14em]">
                  {group.allLabel}
                </SelectLabel>
                {rest.map((choice) => (
                  <ChoiceItem key={choice.value} choice={choice} />
                ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * An option that is mostly off, presented as one.
 *
 * Subtitles and metadata used to sit behind an "Advanced" fold, which asked
 * people to open a section to find out whether there was anything in it worth
 * having. As switches the answer is on the face of the panel, and the choices
 * only appear once someone has said they want any - a dropdown reading "None"
 * is an answer to a question nobody asked.
 */
function ToggleGroup({
  group,
  value,
  onChange,
}: {
  group: OptionGroup
  value: string
  onChange: (value: string) => void
}) {
  const toggle = group.toggle
  if (!toggle) {
    return <ConfigDropdown group={group} value={value} onChange={onChange} />
  }

  const on = value !== toggle.off

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
          {group.label}
        </span>
        <Switch
          checked={on}
          aria-label={group.label}
          onCheckedChange={(next) => onChange(next ? toggle.on : toggle.off)}
        />
      </div>

      {on ? (
        <ConfigDropdown
          group={group}
          value={value}
          onChange={onChange}
          hideLabel
        />
      ) : null}
    </div>
  )
}

function ModeToggle({
  mode,
  onModeChange,
}: {
  mode: ConfigureMode
  onModeChange: (mode: ConfigureMode) => void
}) {
  return (
    // Full width, with the two halves splitting it evenly - `TabsTrigger`
    // already carries `flex-1`, so only the list needs telling. It is the
    // panel's first control and the one that changes what everything below it
    // means, so it reads better as a two-way switch than as a pair of chips
    // tucked into a corner.
    <Tabs
      value={mode}
      onValueChange={(value) => onModeChange(value as ConfigureMode)}
      className="w-full"
    >
      <TabsList className="h-8 w-full">
        <TabsTrigger value="video" className="text-[10px]">
          <RiVideoLine className="size-4" />
          Video
        </TabsTrigger>
        <TabsTrigger value="audio" className="text-[10px]">
          <RiMusicLine className="size-4" />
          Audio
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export function ConfigurePanel({
  options,
  onOptionsChange,
  onOpenDetails,
  onOpenExpert,
  preview,
  downloadDirectory,
  serviceDirectory,
  onChangeDirectory,
}: {
  options: DownloadOptions
  onOptionsChange: (options: DownloadOptions) => void
  onOpenDetails: () => void
  onOpenExpert: () => void
  preview: Preview
  /** Null until the service has said where it writes. */
  /** The app-side override, exactly as stored. Empty means the service's. */
  downloadDirectory: string
  /** The service's own folder, shown as the placeholder. Null while unknown. */
  serviceDirectory: string | null
  /** Writes the app-side override; empty falls back to the service. */
  onChangeDirectory: (path: string) => void
}) {
  const spotify = useSettingsConfig().spotify
  // "Set up" means somewhere to put it. Without that the switch would be an
  // offer the app cannot keep, so the row is not shown at all - Settings is
  // where that gets fixed, not here.
  const spotifyReady = spotifyDeliveryReady(spotify)
  const spotifyProblem = spotifyFormatProblem(options.mode, options.audioFormat)
  const spotifyOn = options.spotify && !spotifyProblem
  const [explaining, setExplaining] = useState(false)
  const { setActive } = useActiveSection()

  // Moving only happens when the download is going to exactly one folder and
  // the original is not being kept: with several folders the earlier ones must
  // copy, or there would be nothing left for the last one to move.
  const spotifyMoves =
    spotifyOn && !spotify.keepOriginal && spotify.folders.length === 1

  const spotifyOutcome = spotifyProblem
    ? spotifyProblem
    : spotifyMoves
      ? "Moved into your local files - it will not be kept below."
      : spotify.folders.length === 1
        ? "Copied into your local files when it finishes."
        : `Copied into ${spotify.folders.length} local-file folders when it finishes.`

  const groups = optionGroups[options.mode]

  // Right-clicking the block that talks about Spotify should lead to the
  // place that configures it - the alternative is describing where to find it
  // in prose nobody reads. One item, drawn by the same menu every other
  // right-click in the app uses, so it cannot look like a different app.
  const spotifyMenu: RowAction[][] = [
    [
      {
        label: "Spotify settings",
        hint: "Folders, account and how files are delivered",
        icon: RiSettings3Line,
        run: () => {
          requestSettingsSection("spotify")
          setActive("settings")
        },
      },
    ],
  ]

  return (
    <aside className="flex h-full w-full flex-col bg-[color-mix(in_oklab,var(--foreground)_2%,transparent)]">
      <div className="flex shrink-0 flex-col gap-3 border-b p-4">
        {/* No heading: the panel is the only thing in its pane, and the tabs
            say what it configures more usefully than the word "Configure"
            did. */}
        <ModeToggle
          mode={options.mode}
          onModeChange={(mode) => onOptionsChange({ ...options, mode })}
        />

        <VideoSummary
          preview={preview}
          onOpenDetails={onOpenDetails}
          onOpenExpert={onOpenExpert}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <PanelSection title="Format">
            {groups.primary.map((group) => (
              <ConfigDropdown
                key={group.key}
                group={group}
                value={valueOf(options, group.key)}
                onChange={(value) =>
                  onOptionsChange(withValue(options, group.key, value))
                }
              />
            ))}
          </PanelSection>

          {/* One box each: subtitles and metadata are separate decisions, and
              a single box holding both would say they were one. */}
          {groups.toggles.map((group) => (
            <PanelSection key={group.key}>
              <ToggleGroup
                group={group}
                value={valueOf(options, group.key)}
                onChange={(value) =>
                  onOptionsChange(withValue(options, group.key, value))
                }
              />
            </PanelSection>
          ))}

          {/* The switch is a statement of intent, so it is always usable -
              turning it on before a link is even pasted is the normal way to
              queue a batch. Whether the *current* format can actually be
              delivered is a separate question, answered underneath, because
              locking the control would leave nothing to explain. */}
          {options.mode === "audio" && spotifyReady ? (
            <RowContextMenu groups={spotifyMenu}>
              <PanelSection className="gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[9.5px] tracking-widest uppercase">
                      Add to Spotify
                    </div>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                      {spotifyOutcome}
                    </p>
                  </div>
                  <Switch
                    aria-label="Add this download to Spotify local files"
                    checked={options.spotify}
                    onCheckedChange={(spotify) =>
                      onOptionsChange({ ...options, spotify })
                    }
                  />
                </div>

                {/* Only once they have asked for it. A warning about a format
                  nobody is trying to deliver is just noise. */}
                {options.spotify && spotifyProblem ? (
                  <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 px-2 py-1.5">
                    <RiAlertLine className="mt-px size-3 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] leading-snug text-destructive">
                        {spotifyProblem}
                      </p>
                      <button
                        type="button"
                        onClick={() => setExplaining(true)}
                        className="mt-1 text-[10px] tracking-wide text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                      >
                        Why not?
                      </button>
                    </div>
                  </div>
                ) : null}
              </PanelSection>
            </RowContextMenu>
          ) : null}

          {/* Dimmed when the download is going to be moved: the folder below
              is still where it lands first, but it will not be there
              afterwards, and showing it at full strength would be a promise
              the app is about to break. */}
          <PanelSection title="Save to" className="gap-3">
            {/* Outside the dimming below, because it is the control that
                causes it - a switch greyed out by its own setting cannot be
                turned back off. */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-medium">
                  Ask when it finishes
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                  {options.askWhereToSave
                    ? "You will be asked where to put this one once it is downloaded."
                    : spotifyMoves
                      ? "Moved into your local files - it will not be kept below."
                      : "Saved straight into the folder below."}
                </p>
              </div>
              <Switch
                aria-label="Ask where to save this download"
                checked={options.askWhereToSave}
                onCheckedChange={(askWhereToSave) =>
                  onOptionsChange({ ...options, askWhereToSave })
                }
              />
            </div>

            {/* Dimmed when the folder is not where this download will end up:
                still true for everything else, but a promise about this one
                that the app is about to break. */}
            <div
              className={cn(
                "transition-opacity",
                (spotifyMoves || options.askWhereToSave) && "opacity-40"
              )}
            >
              {/* Bound to the stored setting itself rather than to
                  setting-or-fallback, so this and the Settings screen are two
                  views of one string: what is typed here is what is shown
                  there. Binding it to the fallback meant the first keystroke
                  silently wrote the service's own path into the setting. Where
                  files go while it is empty is the placeholder's job, which is
                  what a placeholder is for. */}
              <FolderField
                value={downloadDirectory}
                onValueChange={onChangeDirectory}
                fallback={serviceDirectory ?? undefined}
              />
            </div>
          </PanelSection>

          {options.formatId ? (
            <div className="flex items-center justify-between gap-2 border border-dashed px-2 py-1.5 font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground uppercase">
              <span className="min-w-0 truncate">
                format {options.formatId}
              </span>
              <button
                type="button"
                className="shrink-0 underline underline-offset-2 hover:text-foreground"
                onClick={() => onOptionsChange({ ...options, formatId: null })}
              >
                clear
              </button>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <Dialog open={explaining} onOpenChange={setExplaining}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base normal-case">
              Spotify local files are fussy
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              Spotify only plays three kinds of file from a local folder, and
              the one this app saves by default is not among them.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-[12.5px] leading-relaxed">
            <div>
              <div className="font-medium">It will play</div>
              <p className="mt-0.5 text-muted-foreground">
                MP3, M4P, and MP4 &mdash; but only MP4 with no video track in
                it.
              </p>
            </div>
            <div>
              <div className="font-medium">It will not play</div>
              <p className="mt-0.5 text-muted-foreground">
                M4A, which is this app&rsquo;s default audio format, along with
                Opus, FLAC, WAV and everything else. A file it cannot play is
                not rejected &mdash; it is simply ignored, so it would sit in
                the folder looking delivered.
              </p>
            </div>
            <div>
              <div className="font-medium">What to change</div>
              <p className="mt-0.5 text-muted-foreground">
                Set <span className="font-mono text-foreground">Format</span> to{" "}
                <span className="font-mono text-foreground">MP3</span> above.
                The switch can stay on in the meantime; it only takes effect
                once the format is one Spotify accepts.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button size="sm" onClick={() => setExplaining(false)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="shrink-0 overflow-hidden border-t">
        <Compat options={options} preview={preview} />
      </div>
    </aside>
  )
}

/**
 * Whether this combination copies streams or re-encodes. Derived from the
 * choice, not from a fixture: a container the source codec already fits is a
 * remux, and everything else costs real time.
 *
 * Collapsible because it is reference material - the label alone answers the
 * question most of the time, and the explanation is worth a line of the panel
 * only when someone is actually wondering why. Collapsed by default so the
 * options above get the height.
 */
function Compat({
  options,
  preview,
}: {
  options: DownloadOptions
  preview: Preview
}) {
  const [open, setOpen] = useState(false)

  const reEncodes =
    options.mode === "audio"
      ? !["keep", "m4a", "opus"].includes(options.audioFormat)
      : options.subtitles === "all"

  const label = reEncodes ? "Re-encode — slower" : "Remux — instant"
  const detail = reEncodes
    ? options.mode === "audio"
      ? `Audio is decoded and re-encoded to ${options.audioFormat.toUpperCase()}.`
      : "Extra subtitle tracks are muxed in after the download."
    : options.mode === "audio"
      ? "Audio stream is copied straight out of the container."
      : "Video and audio streams are copied without touching the pixels."

  const size =
    preview.video?.duration && options.mode === "audio"
      ? ` Roughly ${formatBytes((options.audioQuality * 1000 * preview.video.duration) / 8)}.`
      : ""

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      {/* The whole band is the trigger, and its hit area is padding. It used
          to bleed to the panel edges with negative margins on both axes, which
          is where the seams came from: the horizontal pull made the highlight
          wider than the row, and the vertical pull ate into the column's gap,
          so the strip between this and its neighbours was clickable on one
          pass and not on the next. Padded and in-flow, the target and the
          highlight are the same rectangle. */}
      <CollapsibleTrigger
        render={
          <button
            type="button"
            aria-label={open ? "Hide the detail" : "Explain this"}
            className={cn(
              "group/compat flex w-full items-center gap-2 px-2 py-2 text-left outline-none select-none",
              "transition-colors duration-200",
              // Keyboard focus keeps a tint. `outline-none` above removes the
              // browser's own ring, so without this there would be nothing at
              // all to show where focus is - which is a different problem from
              // a hover highlight nobody asked for.
              "focus-visible:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]"
            )}
          />
        }
      >
        {/* One element, not two swapped ones: the badge treatment is a set of
            transitioned properties on the same node, so opening eases the
            border and padding in rather than replacing the label. */}
        <span
          className={cn(
            "flex items-center gap-2 font-mono text-[9.5px] tracking-widest whitespace-nowrap uppercase",
            // Padding is constant and only paint properties are transitioned.
            // It used to ease `padding` as well, which is a layout property:
            // the browser reflows on every frame, and the rule and the arrow
            // beside this are pushed along with it, so the whole band shuffled
            // instead of the badge simply appearing. Colour, background and
            // the inset border can all animate without moving anything.
            "px-2 py-1",
            "transition-[background-color,box-shadow,color] duration-200",
            open
              ? "bg-muted/40 shadow-[inset_0_0_0_1px_var(--border)]"
              : "bg-transparent shadow-[inset_0_0_0_0_transparent]",
            reEncodes
              ? "text-destructive"
              : open
                ? "text-foreground"
                : "text-muted-foreground"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 transition-colors duration-200",
              reEncodes
                ? "bg-destructive"
                : open
                  ? "bg-current"
                  : "bg-foreground/50"
            )}
          />
          {label}
        </span>

        <span className="h-px flex-1 bg-border" />

        <RiArrowDownSLine
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/compat:text-foreground",
            open && "rotate-180"
          )}
        />
      </CollapsibleTrigger>

      {/* Clicking the explanation closes it again, so the whole area is a
          toggle in both states. */}
      <CollapsibleContent
        onClick={() => setOpen(false)}
        className="data-open:inferno-collapsible-down data-closed:inferno-collapsible-up overflow-hidden select-none"
      >
        <p className="px-2 pt-1 pb-2 font-mono text-[9.5px] leading-[1.6] tracking-[0.03em] text-muted-foreground">
          {detail}
          {size}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ConfirmButton({
  mode,
  busy,
  disabled,
  onClick,
}: {
  mode: ConfigureMode
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  const label = mode === "audio" ? "Download audio" : "Download"

  return (
    <Button
      size="icon"
      className="size-11 shrink-0"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {busy ? (
        <Spinner className="size-4" />
      ) : (
        <RiDownloadLine className="size-4" />
      )}
    </Button>
  )
}
