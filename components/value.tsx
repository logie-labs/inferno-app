"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatExact,
} from "@/lib/format"
import { cn } from "@/lib/utils"

export type ValueType = "bytes" | "count" | "duration"

const compact: Record<ValueType, (value: number) => string> = {
  bytes: formatBytes,
  count: formatCount,
  duration: formatDuration,
}

/** The plain-text truth sitting behind the compact form. */
const plain: Record<ValueType, (value: number) => string> = {
  bytes: (value) => `${formatExact(value)} bytes`,
  count: formatExact,
  duration: (value) => `${formatExact(value)} seconds`,
}

/**
 * Counts default to showing the tooltip: "185K" hides a real number someone
 * may want to read. Sizes and durations default to hiding it, because the
 * exact byte count is noise nobody asked for.
 */
const tooltipByDefault: Record<ValueType, boolean> = {
  bytes: false,
  count: true,
  duration: false,
}

/** Whether the compact form actually hid anything worth revealing. */
const abbreviates: Record<ValueType, (value: number) => boolean> = {
  bytes: (value) => value >= 1024,
  count: (value) => Math.abs(value) >= 1000,
  duration: () => true,
}

/**
 * Renders a number in its compact form for `type`, optionally revealing the
 * untruncated figure on hover. Every formatted number in the UI goes through
 * this, so nothing is formatted at the call site.
 */
export function Value({
  value,
  type,
  exact = tooltipByDefault[type],
  className,
}: {
  value: number
  type: ValueType
  /** Show the true value in a tooltip on hover. Defaults per type. */
  exact?: boolean
  className?: string
}) {
  const text = compact[type](value)

  // Below the first unit step nothing was abbreviated, so a tooltip would only
  // repeat what is already on screen.
  if (!exact || !abbreviates[type](value)) {
    return <span className={className}>{text}</span>
  }

  return (
    // A short pause: the exact figure is a second thought, not the point of
    // pointing at it. Delay is set on the provider in Base UI, so this one
    // brings its own rather than changing it app-wide.
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={<span className={cn("cursor-help", className)}>{text}</span>}
        />
        <TooltipContent>{plain[type](value)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
