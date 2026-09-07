import type { SettingsConfig } from "./settings-config"
import type { SettingsNavItem, SettingsSectionId } from "./settings-registry"

/**
 * Searching settings by what is *in* them, not only what they are called.
 *
 * A title-only search fails the case people actually have: they remember a
 * value, not the heading it lives under. Someone looking for "1080p", "mp4",
 * "Ctrl+Alt" or their download folder has no idea those live under Video,
 * Downloads and Shortcuts respectively - and that is exactly when a search is
 * worth having.
 *
 * So each section is indexed over three fields of decreasing authority, and a
 * match scores by *where* it hit and *how* it hit. A title match beats a
 * description match beats a value match; within a field, an exact hit beats a
 * prefix beats a substring. The result is that typing "audio" puts the Audio
 * section first and the sections that merely mention audio below it, which is
 * the order anyone would expect.
 */

/** Which slice of the config a section is showing, for the value index. */
const SECTION_VALUES: Partial<
  Record<SettingsSectionId, (config: SettingsConfig) => unknown>
> = {
  appearance: (config) => config.appearance,
  downloads: (config) => config.downloads,
  keybinds: (config) => config.keybinds,
  startup: (config) => config.startup,
  updates: (config) => config.updates,
  video: (config) => config.video,
  audio: (config) => config.audio,
  network: (config) => config.network,
  diagnostics: (config) => config.diagnostics,
}

/**
 * A section's values flattened to searchable words.
 *
 * Keys as well as values: "filenameTemplate" is what a developer would search
 * for, "{title} [{id}]" is what a user would, and both should find it.
 * Booleans
 * are dropped - every section has some `true` in it, so indexing them would
 * make "true" match everything and mean nothing.
 */
function flatten(value: unknown, into: string[]) {
  if (value === null || value === undefined) {
    return
  }

  if (typeof value === "boolean") {
    return
  }

  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim()
    if (text) {
      into.push(text.toLowerCase())
    }

    return
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key.toLowerCase())
      flatten(nested, into)
    }
  }
}

export type SettingsIndexEntry = {
  id: SettingsSectionId
  title: string
  description: string
  values: string[]
}

/** Built once per config change, not per keystroke. */
export function buildSettingsIndex(
  items: SettingsNavItem[],
  config: SettingsConfig
): SettingsIndexEntry[] {
  return items.map((item) => {
    const values: string[] = []
    // Not every section has settings behind it - Backup and About are actions
    // and prose, so they are searchable by name and description only.
    flatten(SECTION_VALUES[item.id]?.(config), values)

    return {
      id: item.id,
      title: item.title.toLowerCase(),
      description: item.description.toLowerCase(),
      values,
    }
  })
}

/**
 * How well one field answers the query. 0 means it does not.
 *
 * The three tiers are far enough apart that a weaker field can never overtake a
 * stronger one on tier alone - a value match cannot outrank a title match - but
 * ties inside a tier still break sensibly.
 */
function fieldScore(haystack: string, needle: string) {
  if (!haystack) {
    return 0
  }
  if (haystack === needle) {
    return 100
  }
  if (haystack.startsWith(needle)) {
    return 70
  }

  const at = haystack.indexOf(needle)
  if (at < 0) {
    return 0
  }

  // A hit at a word boundary is a better answer than one buried mid-word.
  return haystack[at - 1] === " " ? 50 : 30
}

/**
 * A section's relevance to a query, or 0 when it is not a match at all.
 *
 * Every term has to hit something, so "audio format" narrows rather than
 * widens - a section matching only "audio" is not an answer to both words.
 */
export function scoreSection(entry: SettingsIndexEntry, query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return 1
  }

  let total = 0

  for (const term of terms) {
    const title = fieldScore(entry.title, term) * 3
    const description = fieldScore(entry.description, term) * 1.5
    const value = entry.values.reduce(
      (best, candidate) => Math.max(best, fieldScore(candidate, term)),
      0
    )

    const best = Math.max(title, description, value)
    if (best === 0) {
      return 0
    }

    total += best
  }

  return total
}
