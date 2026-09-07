"use client"

import { useState } from "react"
import { RiInformationLine } from "@remixicon/react"

import { Skeleton } from "@/components/ui/skeleton"
import { useCachedThumbnail } from "@/lib/thumbnail-cache"
import { cn } from "@/lib/utils"

/** Shown until a row has resolved metadata, and for anything with no artwork. */
export function ThumbBox({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "inferno-hatch flex shrink-0 items-center justify-center font-mono text-[8px] tracking-[0.12em] text-muted-foreground uppercase shadow-[inset_0_0_0_1px_var(--border)] select-none",
        className
      )}
    >
      thumb
    </div>
  )
}

/**
 * A row's artwork, and the way into everything known about the video.
 *
 * Shared by the live queue rows and the finished ones. They drew their own
 * thumbnails before, which is how one of them ended up clickable and the other
 * not - the same picture in the same list behaving differently depending on
 * whether the download had finished.
 *
 * `onOpen` is what makes it a button. Without it the artwork stays a plain
 * image rather than becoming a control that does nothing, which is the right
 * outcome for a row whose metadata never arrived.
 */
export function Thumbnail({
  url,
  title,
  onOpen,
  dimmed,
}: {
  url: string | null
  title: string
  onOpen?: () => void
  /** A file that is no longer where it was: greyed, like the rest of its row. */
  dimmed?: boolean
}) {
  // The stored copy once there is one, the CDN until then. Falling back
  // rather than waiting means the first sight of a row is never slower than
  // it was before the cache existed.
  const cached = useCachedThumbnail(url)

  // Both keyed by the URL rather than held as plain booleans, so swapping
  // the CDN copy for the cached one - the same picture, a different `src` -
  // does not read as a new image starting to load and flash the skeleton back.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  const loaded = url !== null && loadedUrl === url
  const failed = url !== null && failedUrl === url

  const art =
    url && !failed ? (
      <div className="relative h-10.75 w-19 shrink-0">
        {/* Underneath rather than instead of, so the image is decoding while
            this is on screen. Swapping one for the other would only start the
            load once the skeleton came off. */}
        {loaded ? null : <Skeleton className="absolute inset-0 size-full" />}

        {/* A remote thumbnail from an arbitrary extractor host; `next/image`
            would need every one of them declared up front. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={cached ?? url}
          alt=""
          width={76}
          height={43}
          // `draggable` off as well as `select-none`: the two are separate
          // behaviours, and an image is draggable by default, so dragging
          // across a row would pick the picture up and leave a ghost
          // following the cursor.
          draggable={false}
          onLoad={() => setLoadedUrl(url)}
          // A host that will not answer is not a row that waits forever: it
          // falls back to the same box a row with no artwork gets.
          onError={() => setFailedUrl(url)}
          className={cn(
            "relative size-full object-cover shadow-[inset_0_0_0_1px_var(--border)] transition-opacity duration-200 select-none",
            !loaded
              ? "opacity-0"
              : dimmed
                ? "opacity-40 grayscale"
                : "opacity-100"
          )}
        />
      </div>
    ) : (
      <ThumbBox className={cn("h-10.75 w-19", dimmed && "opacity-40")} />
    )

  if (!onOpen) {
    return (
      <div title={title} className="select-none">
        {art}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${title} — click for details`}
      className="group/thumb relative shrink-0 outline-none select-none"
    >
      {art}
      {/* A hint on hover rather than a permanent badge: the row is a list item,
          and a persistent icon on every one of them is noise. */}
      <span className="absolute inset-0 flex items-center justify-center bg-background/60 opacity-0 transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100">
        <RiInformationLine className="size-4" />
      </span>
    </button>
  )
}
