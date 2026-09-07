"use client"

import { useState, type ComponentType } from "react"

import {
  RiCalendarLine,
  RiChat3Line,
  RiCheckLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiListUnordered,
  RiThumbUpLine,
  RiTimeLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Value } from "@/components/value"
import { describeError, openUrl, type VideoInfo } from "@/lib/inferno-service"

import { cn } from "@/lib/utils"

import { LanguageFlag } from "@/components/ui/flag"
import { useLingering } from "@/lib/use-lingering"

import { humanise, languageName, videoFacts } from "./video-facts"

/**
 * A link that opens in the user's own browser rather than inside the app.
 *
 * Not an `<a href>`: this window is the application, and letting it navigate
 * away from the UI would strand the user with no way back. Falls back to plain
 * text when there is nothing to link to.
 */
function ExternalLink({
  href,
  children,
  className,
}: {
  href: string | null | undefined
  children: React.ReactNode
  className?: string
}) {
  if (!href) {
    return <>{children}</>
  }

  return (
    <button
      type="button"
      title={href}
      onClick={() => {
        void openUrl(href).catch((error: unknown) => {
          toast.error(describeError(error))
        })
      }}
      className={cn(
        "inline-flex max-w-full items-center gap-1 text-left underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground hover:decoration-solid",
        className
      )}
    >
      {children}
      <RiExternalLinkLine className="size-3 shrink-0 opacity-60" />
    </button>
  )
}

/** Icon plus figure - the metric is carried by the icon, not a written label. */
function Stat({
  icon: StatIcon,
  label,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2" title={label}>
      <StatIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-mono text-xs">{children}</span>
      <span className="sr-only">{label}</span>
    </div>
  )
}

/**
 * A labelled row. Renders nothing when there is nothing to say, so a source
 * that reports no licence or no captions simply has no such row rather than a
 * row reading "unknown".
 */
function DetailRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const empty =
    children === null || children === undefined || children === false

  return (
    <div className="flex items-baseline gap-4 py-2">
      <div className="w-28 shrink-0 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </div>
      <div className="min-w-0 flex-1 font-mono text-xs">
        {/* Said, not hidden. A row that disappears leaves you wondering
            whether the field exists at all; italics keep it clearly apart
            from a real value. */}
        {empty ? (
          <span className="text-muted-foreground italic">Not available</span>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

/**
 * Every caption track, with the flag of the language's likely region.
 *
 * A second dialog on top of the details rather than a section inside it: the
 * list can run to eighty languages on a large channel, and burying that in a
 * row would either crush it or push everything else off the screen.
 */
function SubtitleListDialog({
  open,
  codes,
  automatic,
  onOpenChange,
}: {
  open: boolean
  codes: string[]
  automatic: string[]
  onOpenChange: (open: boolean) => void
}) {
  // Manual tracks first, then the machine-generated ones, each alphabetical by
  // the name actually shown rather than by language code.
  const rows = [
    ...codes.map((code) => ({ code, auto: false })),
    ...automatic
      .filter((code) => !codes.includes(code))
      .map((code) => ({ code, auto: true })),
  ].sort(
    (a, b) =>
      Number(a.auto) - Number(b.auto) ||
      languageName(a.code).localeCompare(languageName(b.code))
  )

  return (
    // Always mounted, opened by the prop: rendering it only while open meant
    // it was torn out of the tree the moment it closed, so it disappeared
    // instead of fading.
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] flex-col gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base normal-case">Subtitles</DialogTitle>
          {/* "0 tracks, and 157 generated automatically" was technically
              true and read like a bug. Each case gets its own sentence. */}
          <DialogDescription>
            {codes.length === 0
              ? `${automatic.length} automatic ${automatic.length === 1 ? "track" : "tracks"}, all machine generated.`
              : automatic.length === 0
                ? `${codes.length} ${codes.length === 1 ? "track" : "tracks"}.`
                : `${codes.length} ${codes.length === 1 ? "track" : "tracks"}, plus ${automatic.length} generated automatically.`}
          </DialogDescription>
        </DialogHeader>

        {/* `viewportClassName` caps the viewport itself: this dialog is
            sized by `max-height`, so `h-full` on the viewport would resolve to
            `auto` and nothing would ever overflow. */}
        <ScrollArea
          className="min-h-0 flex-1 border"
          viewportClassName="max-h-[calc(70vh-8rem)]"
        >
          {rows.map((row) => (
            <div
              key={`${row.code}-${row.auto}`}
              className="flex items-center gap-2.5 border-b px-3 py-2 text-sm last:border-b-0"
            >
              <LanguageFlag code={row.code} />
              <span className="min-w-0 flex-1 truncate">
                {languageName(row.code)}
              </span>
              {/* Only when it adds something. For a language nothing can name,
                  the "name" is the code, and printing it twice reads as a
                  glitch. */}
              {languageName(row.code) === row.code ? null : (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {row.code}
                </span>
              )}
              {row.auto ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  auto
                </span>
              ) : null}
            </div>
          ))}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function SubtitleBadges({
  codes,
  automatic,
  onShowAll,
}: {
  codes: string[]
  automatic: string[]
  onShowAll: () => void
}) {
  if (codes.length === 0 && automatic.length === 0) {
    return null
  }

  const shown = codes.slice(0, 6)
  const total = codes.length + automatic.length

  return (
    <span className="flex flex-wrap items-center gap-2">
      {shown.map((code) => (
        <Badge
          key={code}
          className="gap-1.5 py-0.5 pr-1.5 pl-1.5 text-[10px] tracking-normal normal-case shadow-[inset_0_0_0_1px_var(--border)]"
        >
          <LanguageFlag code={code} />
          {languageName(code)}
        </Badge>
      ))}

      {/* The count is the way in to the rest. It is a button whenever there is
          a list worth opening, which is any time there are tracks at all -
          six badges is a sample, not the answer to "which languages". */}
      <button
        type="button"
        onClick={onShowAll}
        className="text-muted-foreground underline decoration-transparent underline-offset-2 transition-colors hover:text-foreground hover:decoration-current"
      >
        {codes.length > shown.length
          ? `+ ${codes.length - shown.length} more`
          : `all ${total}`}
        {automatic.length > 0 ? ` · ${automatic.length} auto` : ""}
      </button>
    </span>
  )
}

export function VideoDetailsDialog({
  video,
  open,
  onOpenChange,
}: {
  video: VideoInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  /** Whether the full subtitle list is open on top of this one. */
  const [listing, setListing] = useState(false)

  // The queue clears `video` as it closes this, which would unmount the whole
  // dialog before it had a chance to animate out.
  const shown = useLingering(video)

  if (!shown) {
    return null
  }

  const facts = videoFacts(shown)
  const { bestVideo, bestAudio, formats } = facts

  return (
    // Siblings, not nested. Rendering the subtitle list inside this dialog's
    // content put it inside this dialog's dismissal region too, so clicking
    // away from the list was read as a click *within* the details - and the
    // thing you were trying to close stayed open. As a sibling it owns its own
    // outside-press handling, and being rendered second puts it on top.
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* No close button at all: the corner X would sit on top of the
          thumbnail, and a footer one collided with the scrolling content.
          Escape and a click outside both still dismiss it. */}
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100svh-4rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          {/* The cap lives on the viewport, not on an ancestor: `h-full` only
            resolves against a specified height, and this dialog is sized by
            `max-height`, so without it the viewport grows to its content and
            never scrolls. */}
          <ScrollArea viewportClassName="max-h-[calc(100svh-4rem)]">
            <div className="flex flex-col gap-4 p-6">
              {facts.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={facts.thumbnail}
                  alt=""
                  className="aspect-video w-full bg-muted object-cover shadow-[inset_0_0_0_1px_var(--border)]"
                />
              ) : (
                <div className="inferno-hatch flex aspect-video w-full items-center justify-center font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase shadow-[inset_0_0_0_1px_var(--border)]">
                  no thumbnail
                </div>
              )}

              <DialogHeader>
                <DialogTitle className="text-base normal-case">
                  {facts.title ?? "Untitled"}
                </DialogTitle>
                {facts.description ? (
                  <DialogDescription className="line-clamp-4 whitespace-pre-line">
                    {facts.description}
                  </DialogDescription>
                ) : null}
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {facts.views !== null ? (
                  <Stat icon={RiEyeLine} label="Views">
                    <Value value={facts.views} type="count" />
                  </Stat>
                ) : null}
                {facts.likes !== null ? (
                  <Stat icon={RiThumbUpLine} label="Likes">
                    <Value value={facts.likes} type="count" />
                  </Stat>
                ) : null}
                {facts.comments !== null ? (
                  <Stat icon={RiChat3Line} label="Comments">
                    <Value value={facts.comments} type="count" />
                  </Stat>
                ) : null}
                {facts.duration ? (
                  <Stat icon={RiTimeLine} label="Duration">
                    <Value value={facts.duration} type="duration" />
                  </Stat>
                ) : null}
                {facts.published ? (
                  <Stat icon={RiCalendarLine} label="Published">
                    {facts.published}
                  </Stat>
                ) : null}
                {facts.chapters ? (
                  <Stat icon={RiListUnordered} label="Chapters">
                    <Value value={facts.chapters} type="count" />
                  </Stat>
                ) : null}
              </div>
            </div>

            <Separator />

            <div className="flex flex-col p-6 py-4">
              <DetailRow label="Channel">
                {facts.channel ? (
                  <>
                    <ExternalLink href={facts.channelUrl}>
                      {facts.channel}
                    </ExternalLink>
                    {facts.subscribers ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        <Value value={facts.subscribers} type="count" />{" "}
                        subscribers
                      </span>
                    ) : null}
                  </>
                ) : null}
              </DetailRow>

              <DetailRow label="Subtitles">
                {/* The emptiness has to be decided here, not inside the
                    badges: an element that renders null is still an
                    element, so `DetailRow` saw a child and drew a blank
                    cell instead of saying there was nothing. */}
                {facts.subtitles.length > 0 || facts.automatic.length > 0 ? (
                  <SubtitleBadges
                    codes={facts.subtitles}
                    automatic={facts.automatic}
                    onShowAll={() => setListing(true)}
                  />
                ) : null}
              </DetailRow>

              <DetailRow label="Best video">
                {bestVideo ? (
                  <>
                    <span className="text-muted-foreground">
                      {bestVideo.id}
                    </span>{" "}
                    {bestVideo.spec}
                    {bestVideo.bytes ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        <Value value={bestVideo.bytes} type="bytes" />
                      </span>
                    ) : null}
                  </>
                ) : null}
              </DetailRow>

              <DetailRow label="Best audio">
                {bestAudio ? (
                  <>
                    <span className="text-muted-foreground">
                      {bestAudio.id}
                    </span>{" "}
                    {bestAudio.spec}
                    {bestAudio.bytes ? (
                      <span className="text-muted-foreground">
                        {" · "}
                        <Value value={bestAudio.bytes} type="bytes" />
                      </span>
                    ) : null}
                  </>
                ) : null}
              </DetailRow>

              <DetailRow label="Formats">
                <Value value={formats.total} type="count" />
                <span className="text-muted-foreground">
                  {" · "}
                  {formats.video} video / {formats.audio} audio
                </span>
              </DetailRow>

              <DetailRow label="Availability">
                {facts.availability ? (
                  <span className="flex items-center gap-1.5">
                    <RiCheckLine className="size-3.5 text-muted-foreground" />
                    {humanise(facts.availability)}
                    {facts.ageLimit ? (
                      <span className="text-muted-foreground">
                        · {facts.ageLimit}+
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </DetailRow>

              <DetailRow label="Source">{facts.source}</DetailRow>

              <DetailRow label="Video ID">{facts.videoId}</DetailRow>

              <DetailRow label="URL">
                {facts.url ? (
                  <ExternalLink href={facts.url} className="w-full">
                    <span className="truncate">{facts.url}</span>
                  </ExternalLink>
                ) : null}
              </DetailRow>

              <DetailRow label="Licence">
                {facts.licence || facts.live || facts.wasLive ? (
                  <>
                    {facts.licence ?? "Not stated"}
                    <span className="text-muted-foreground">
                      {" · "}
                      {facts.live
                        ? "live now"
                        : facts.wasLive
                          ? "was live"
                          : "regular upload"}
                    </span>
                  </>
                ) : null}
              </DetailRow>
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <SubtitleListDialog
        open={listing}
        codes={facts.subtitles}
        automatic={facts.automatic}
        onOpenChange={(next) => {
          if (!next) {
            setListing(false)
          }
        }}
      />
    </>
  )
}
