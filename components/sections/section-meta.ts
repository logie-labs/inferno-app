import type { ComponentType } from "react"

import { RiDownloadLine, RiFolderLine, RiSettings3Line } from "@remixicon/react"

/**
 * What each screen is called and what it looks like - and nothing else.
 *
 * Deliberately free of the section *components*. The command registry needs
 * these icons so the palette and the rail cannot disagree, but importing the
 * component map to get them would form a cycle: sections -> settings screen ->
 * settings store -> command registry -> sections. Metadata has no such
 * dependencies, so it lives on its own and both sides import it.
 *
 * This is the one place a section's identity is written down. Change an icon
 * here and it changes in the rail, in the command menu, and anywhere else that
 * grows a reference to it.
 */
export type SectionKey = "downloads" | "library" | "settings"

export const sectionLabels: Record<SectionKey, string> = {
  downloads: "downloads",
  library: "library",
  settings: "settings",
}

export const sectionIcons: Record<
  SectionKey,
  ComponentType<{ className?: string }>
> = {
  downloads: RiDownloadLine,
  library: RiFolderLine,
  settings: RiSettings3Line,
}

/** Rail order - anything not listed here is pinned to the bottom of the rail. */
export const primarySections: SectionKey[] = ["downloads", "library"]
export const footerSections: SectionKey[] = ["settings"]

/** Rail order, flattened. The order the "Go to" shortcuts are numbered in. */
export const sectionOrder: SectionKey[] = [
  ...primarySections,
  ...footerSections,
]
