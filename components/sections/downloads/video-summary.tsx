"use client"

import {
  RiChat3Line,
  RiEyeLine,
  RiLinkM,
  RiListUnordered,
  RiTableLine,
  RiThumbUpLine,
  RiTimeLine,
} from "@remixicon/react"
import type { ComponentType } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { Value } from "@/components/value"
import { cn } from "@/lib/utils"

import { RuleButton } from "./rule-button"
import { humanise, videoFacts } from "./video-facts"
import type { Preview } from "./preview"

/** One icon-led figure. The icon carries the metric, so there is no label. */
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
    <div className="flex items-center gap-1.5" title={label}>
      <StatIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[10px]">{children}</span>
      <span className="sr-only">{label}</span>
    </div>
  )
}

function Thumb({
  url,
  title,
  className,
}: {
  url: string | null
  title: string
  className?: string
}) {
  if (!url) {
    return (
      <div
        className={cn(
          "inferno-hatch flex shrink-0 items-center justify-center font-mono text-[8px] tracking-[0.12em] text-muted-foreground uppercase shadow-[inset_0_0_0_1px_var(--border)]",
          className
        )}
      >
        thumb
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      title={title}
      className={cn(
        "shrink-0 bg-muted object-cover shadow-[inset_0_0_0_1px_var(--border)]",
        className
      )}
    />
  )
}

/**
 * The panel head: nothing yet, working on it, what went wrong, or the video.
 *
 * Four states rather than three - "no link" and "reading metadata" look
 * different on purpose, so pasting a URL visibly does something before the
 * request comes back.
 */
export function VideoSummary({
  preview,
  onOpenDetails,
  onOpenExpert,
}: {
  preview: Preview
  onOpenDetails: () => void
  onOpenExpert: () => void
}) {
  if (preview.error) {
    return (
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-[12.5px] font-semibold text-destructive">
            Could not read that link
          </div>
          <div className="font-mono text-[9.5px] leading-[1.5] tracking-[0.04em] text-muted-foreground">
            {preview.error}
          </div>
        </div>
        <Thumb url={null} title="" className="h-[54px] w-24" />
      </div>
    )
  }

  if (preview.loading) {
    return (
      <div className="flex min-w-0 items-start gap-3">
        {/* `Skeleton` rather than the same thing written out by hand, so the
            pulse matches every other placeholder in the app. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
          <div className="mt-0.5 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
            Reading metadata
          </div>
        </div>
        <div className="inferno-hatch inferno-pulse h-[54px] w-24 shrink-0 shadow-[inset_0_0_0_1px_var(--border)]" />
      </div>
    )
  }

  if (!preview.video) {
    return (
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate text-[12.5px] font-semibold text-muted-foreground">
            No video loaded
          </div>
          <div className="font-mono text-[9.5px] leading-[1.5] tracking-[0.04em] text-muted-foreground">
            Paste a link below and its details appear here.
          </div>
        </div>
        <Thumb url={null} title="" className="h-[54px] w-24" />
      </div>
    )
  }

  const facts = videoFacts(preview.video)
  const availability = humanise(facts.availability)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            title={facts.title ?? undefined}
            className="line-clamp-2 text-[12.5px] leading-[1.35] font-semibold"
          >
            {facts.title ?? "Untitled"}
          </div>

          {facts.channel ? (
            <div className="truncate font-mono text-[9.5px] tracking-[0.06em] text-muted-foreground">
              {facts.channel}
              {facts.subscribers ? (
                <>
                  {" · "}
                  <Value value={facts.subscribers} type="count" /> subs
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <Thumb
          url={facts.thumbnail}
          title={facts.title ?? ""}
          className="h-[54px] w-24"
        />
      </div>

      {/* Only what this extractor actually reported - a missing count is a
          dropped stat, never a zero. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {facts.duration ? (
          <Stat icon={RiTimeLine} label="Duration">
            <Value value={facts.duration} type="duration" />
          </Stat>
        ) : null}
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
        {facts.chapters ? (
          <Stat icon={RiListUnordered} label="Chapters">
            <Value value={facts.chapters} type="count" />
          </Stat>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] tracking-[0.08em] text-muted-foreground uppercase">
        <span>{facts.formats.total} formats</span>
        <span aria-hidden className="size-0.75 bg-foreground/25" />
        <span>
          {facts.formats.video} video / {facts.formats.audio} audio
        </span>
        {facts.published ? (
          <>
            <span aria-hidden className="size-0.75 bg-foreground/25" />
            <span>{facts.published}</span>
          </>
        ) : null}
        {facts.live ? (
          <>
            <span aria-hidden className="size-0.75 bg-foreground/25" />
            <span className="text-destructive">live</span>
          </>
        ) : null}
        {availability && availability !== "Public" ? (
          <>
            <span aria-hidden className="size-0.75 bg-foreground/25" />
            <span>{availability}</span>
          </>
        ) : null}
      </div>

      {/* Everything here is about the video in front of you, which is
          what the raw format table is too - it belonged with these rather
          than at the bottom of a column of settings. Rendered only when
          there is a video, like the link beside it, rather than sitting
          there disabled. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <RuleButton onClick={onOpenDetails}>All details</RuleButton>
        {preview.video ? (
          <RuleButton rule={false} onClick={onOpenExpert}>
            <span className="flex items-center gap-1.5">
              <RiTableLine className="size-3" />
              Raw formats
            </span>
          </RuleButton>
        ) : null}
        {facts.url ? (
          <RuleButton
            rule={false}
            onClick={() => void navigator.clipboard?.writeText(facts.url ?? "")}
          >
            <span className="flex items-center gap-1.5">
              <RiLinkM className="size-3" />
              Copy link
            </span>
          </RuleButton>
        ) : null}
      </div>
    </div>
  )
}
