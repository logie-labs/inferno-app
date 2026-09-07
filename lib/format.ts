/**
 * Display formatters. Every number the UI shows compactly goes through one of
 * these so a value is never hand-formatted at the call site.
 */

const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const
const countUnits = ["", "K", "M", "B", "T"] as const

/**
 * Fewer decimals the further up a unit the value sits, with trailing zeros
 * dropped - so "1.4 GB", never "1.40 GB". Sizes keep a second decimal at the
 * bottom of a unit where it carries real weight (2.15 GB); counts never do,
 * because "9.2K likes" reads and "9.24K likes" does not.
 */
function trim(value: number, maxDecimals: 1 | 2) {
  const decimals =
    value >= 100 ? 0 : value >= 10 ? Math.min(1, maxDecimals) : maxDecimals

  return Number.parseFloat(value.toFixed(decimals)).toString()
}

/**
 * Picks the largest unit the value fills, 1024 to a step.
 *
 * `formatBytes(2254857830)` -> "2.1 GB", `formatBytes(860160)` -> "840 KB".
 */
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${unit === 0 ? Math.round(value) : trim(value, 2)} ${byteUnits[unit]}`
}

/**
 * Picks the largest unit the value fills, 1000 to a step. Anything under a
 * thousand is left alone.
 *
 * `formatCount(184902)` -> "185K", `formatCount(9241)` -> "9.2K".
 */
export function formatCount(value: number) {
  if (!Number.isFinite(value)) {
    return "0"
  }

  const sign = value < 0 ? "-" : ""
  let scaled = Math.abs(value)
  let unit = 0

  while (scaled >= 1000 && unit < countUnits.length - 1) {
    scaled /= 1000
    unit += 1
  }

  if (unit === 0) {
    return `${sign}${Math.round(scaled)}`
  }

  return `${sign}${trim(scaled, 1)}${countUnits[unit]}`
}

/** Thousands-separated, for the title attribute behind a compact value. */
export function formatExact(value: number) {
  return value.toLocaleString("en-GB")
}

/** `2538` -> "42:18", `3725` -> "1:02:05". */
export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const pad = (part: number) => part.toString().padStart(2, "0")

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`
}
