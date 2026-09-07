/**
 * The command registry - what the palette lists, and what a keybind runs.
 *
 * One list, described as data. A command's id is its identity everywhere: the
 * palette keys off it, `keybinds` in settings maps it to a chord, and the
 * rebinding screen renders straight from this array. Adding a command means
 * adding one entry here and nothing else - no new setting, no new UI, no new
 * default to remember, because the default binding is part of the entry and
 * the settings store reads its defaults from this same list.
 *
 * `run` is not here on purpose. What a command *does* needs React context the
 * app assembles at runtime (the active section, the theme, the download queue),
 * and putting handlers in a module-level array would either freeze that context
 * or force every consumer to thread it through. The provider binds ids to
 * handlers instead, and the two halves are checked against each other in tests.
 */

import type { ComponentType } from "react"

import {
  RiBrushLine,
  RiDeleteBinLine,
  RiDownloadCloud2Line,
  RiFolderOpenLine,
  RiMoonLine,
  RiRefreshLine,
  RiTerminalBoxLine,
} from "@remixicon/react"

import {
  sectionIcons,
  sectionLabels,
  sectionOrder,
} from "@/components/sections/section-meta"

export type CommandGroup = "Go to" | "Downloads" | "Appearance" | "App"

export type CommandDefinition = {
  /** Stable across renames - it is what a stored keybind points at. */
  id: string
  title: string
  group: CommandGroup
  /** Extra words the palette should match on but not show. */
  keywords?: string
  icon: ComponentType<{ className?: string }>
  /**
   * The chord this ships with, or "" for a command that is palette-only.
   *
   * Deliberately sparse. Every default binding is a chord taken away from the
   * rest of the system, so only the ones worth reaching for blind get one.
   */
  defaultKeybind: string
}

/** Extra words worth matching on, per section. */
const SECTION_KEYWORDS: Record<string, string> = {
  downloads: "queue jobs",
  library: "files saved history",
  settings: "preferences options config",
}

/**
 * One "Go to" command per section, generated rather than written out.
 *
 * The icon and the name come from the section registry the rail reads, so the
 * palette cannot show a different icon for Library than the rail does - which
 * it did, until this stopped being two lists. Adding a section gives it a
 * command and the next number for free.
 */
const navigationCommands: CommandDefinition[] = sectionOrder.map(
  (key, index) => ({
    id: `go.${key}`,
    // The rail labels are lower-case; a command reads as a sentence.
    title: `Go to ${sectionLabels[key].replace(/^./, (c) => c.toUpperCase())}`,
    group: "Go to" as const,
    keywords: SECTION_KEYWORDS[key],
    icon: sectionIcons[key],
    // Ctrl+1.. in rail order. Past nine there is no digit left, so those
    // sections simply ship without one and can be bound by hand.
    defaultKeybind: index < 9 ? `Ctrl+${index + 1}` : "",
  })
)

/**
 * Tap `Ctrl+Alt` for the palette, `Ctrl+1/2/3` for the three screens.
 *
 * Ctrl+Alt on its own is a *tap*: it fires when both are released with nothing
 * pressed in between, so it costs no chord - `Ctrl+Alt+anything` still works
 * untouched. See `isModifierOnly` in `lib/keybinds.ts` for why it has to be
 * matched on release.
 *
 * Ctrl+1/2/3 are the numbers a person already reaches for to switch tabs, and
 * inside an app window nothing else claims them. Everything here is rebindable
 * in Settings anyway.
 */
export const commands: CommandDefinition[] = [
  {
    id: "palette.open",
    title: "Open command menu",
    group: "App",
    keywords: "palette commands search",
    icon: RiTerminalBoxLine,
    defaultKeybind: "Ctrl+Alt",
  },
  ...navigationCommands,
  {
    id: "downloads.openFolder",
    title: "Open download folder",
    group: "Downloads",
    keywords: "explorer reveal files",
    icon: RiFolderOpenLine,
    defaultKeybind: "Ctrl+Alt+O",
  },
  {
    id: "downloads.retryErrors",
    title: "Retry failed downloads",
    group: "Downloads",
    keywords: "errors failed again",
    icon: RiRefreshLine,
    defaultKeybind: "",
  },
  {
    id: "downloads.clearFinished",
    title: "Clear finished downloads",
    group: "Downloads",
    keywords: "tidy completed remove",
    icon: RiDeleteBinLine,
    defaultKeybind: "",
  },
  {
    id: "downloads.cancelAll",
    title: "Cancel all downloads",
    group: "Downloads",
    keywords: "stop abort",
    icon: RiDeleteBinLine,
    defaultKeybind: "",
  },
  {
    id: "app.checkForUpdates",
    title: "Check for updates",
    group: "App",
    keywords: "version outdated yt-dlp upgrade latest",
    icon: RiDownloadCloud2Line,
    defaultKeybind: "",
  },
  {
    id: "appearance.toggleTheme",
    title: "Toggle light / dark theme",
    group: "Appearance",
    keywords: "dark light mode colours colors",
    icon: RiMoonLine,
    // Unbound on purpose: flipping the whole app's theme is not something to
    // do by accident, and it is one keystroke away in the menu.
    defaultKeybind: "",
  },
  {
    id: "appearance.system",
    title: "Use system theme",
    group: "Appearance",
    keywords: "auto os default",
    icon: RiBrushLine,
    defaultKeybind: "",
  },
]

export const commandMap = new Map(commands.map((entry) => [entry.id, entry]))

/** The shipped bindings, as the settings store wants them. */
export function defaultKeybinds(): Record<string, string> {
  const bindings: Record<string, string> = {}
  for (const command of commands) {
    bindings[command.id] = command.defaultKeybind
  }

  return bindings
}

/**
 * Which other command already answers to this chord.
 *
 * Returns the id, so the caller can name it rather than just refusing. An empty
 * binding never conflicts - any number of commands can have no shortcut.
 */
export function conflictFor(
  bindings: Record<string, string>,
  commandId: string,
  binding: string
): string | null {
  if (!binding) {
    return null
  }

  for (const [id, bound] of Object.entries(bindings)) {
    if (id !== commandId && bound === binding) {
      return id
    }
  }

  return null
}
