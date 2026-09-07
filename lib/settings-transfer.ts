/**
 * Settings as a file: export to one, import from one.
 *
 * The document is deliberately the same JSON the app already stores, wrapped in
 * a small envelope. Nothing is reformatted on the way out, so a file exported by
 * one build is readable by any build that still understands the schema version -
 * and a person who opens it in an editor sees the settings they recognise
 * rather than a serialisation of them.
 *
 * Importing is not trusted. The file may be hand-edited, may come from a much
 * older build, or may not be settings at all, so it goes through the same merge
 * every stored config goes through: unknown keys are dropped, missing ones take
 * their default, and out-of-range numbers are clamped. That merge is the only
 * validator, which is what stops it drifting out of step with the store.
 */

import {
  loadSettingsConfig,
  mergeImportedSettings,
  type SettingsConfig,
} from "@/components/sections/settings/settings-config"

/** What lands on disk. The envelope is what makes a stray JSON file rejectable. */
type SettingsDocument = {
  /** Identifies the file as ours before anything else is believed. */
  kind: "inferno-app.settings"
  /** The store's schema version, so a future build knows what it is reading. */
  schemaVersion: number
  /** Informational only - never read back, but the first thing a human checks. */
  exportedAt: string
  app: string
  settings: SettingsConfig
}

export type TransferResult = {
  cancelled: boolean
  path: string | null
  contents: string | null
}

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function call<T>(command: string, args?: Record<string, unknown>) {
  if (!inTauri()) {
    throw new Error("Importing and exporting settings needs the desktop app.")
  }

  const { invoke } = await import("@tauri-apps/api/core")

  try {
    return await invoke<T>(command, args)
  } catch (cause) {
    const message =
      typeof cause === "object" && cause !== null && "message" in cause
        ? String((cause as { message: unknown }).message)
        : String(cause)
    throw new Error(message)
  }
}

/** `inferno-settings-2026-09-05.json` - sorts by date and says what it is. */
function suggestedName() {
  const today = new Date().toISOString().slice(0, 10)

  return `inferno-settings-${today}.json`
}

/**
 * Write the current settings to a file the user picks.
 *
 * Returns the path, or null when the save dialog was dismissed - which is an
 * ordinary outcome and must not be reported as a failure.
 */
export async function exportSettings(config: SettingsConfig) {
  const document: SettingsDocument = {
    kind: "inferno-app.settings",
    schemaVersion: config.schemaVersion,
    exportedAt: new Date().toISOString(),
    app: "Inferno",
    settings: config,
  }

  const result = await call<TransferResult>("settings_export", {
    // Indented: the file is meant to be readable and diffable, and a settings
    // document is far too small for the whitespace to matter.
    contents: JSON.stringify(document, null, 2),
    suggestedName: suggestedName(),
  })

  return result?.cancelled ? null : (result?.path ?? null)
}

/**
 * The settings inside a document, or a reason it is not one.
 *
 * Split from the file reading so it can be tested without a dialog, and so a
 * paste-in path could reuse it later.
 */
export function parseSettingsDocument(
  contents: string
): { settings: SettingsConfig } | { problem: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { problem: "That file is not valid JSON." }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { problem: "That file does not contain a settings document." }
  }

  const document = parsed as Partial<SettingsDocument>

  if (document.kind !== "inferno-app.settings") {
    return { problem: "That is not an Inferno settings file." }
  }
  if (typeof document.settings !== "object" || document.settings === null) {
    return { problem: "That settings file has no settings in it." }
  }

  // Everything past here is merged rather than trusted, so a file from an older
  // schema still imports - it simply takes today's defaults for whatever it
  // does not mention.
  return { settings: mergeImportedSettings(document.settings) }
}

/**
 * Read a settings file the user picks.
 *
 * Returns null when the picker was dismissed, and throws with a plain reason
 * when the file exists but is not usable.
 */
export async function importSettings() {
  const result = await call<TransferResult>("settings_import")

  if (!result || result.cancelled || result.contents === null) {
    return null
  }

  const parsed = parseSettingsDocument(result.contents)
  if ("problem" in parsed) {
    throw new Error(parsed.problem)
  }

  return { settings: parsed.settings, path: result.path }
}

/** The settings as they stand, for an export triggered outside the screen. */
export function currentSettings() {
  return loadSettingsConfig()
}
