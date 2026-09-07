"use client"

import type { SettingsSectionId } from "./settings-registry"

/**
 * A one-shot request to open Settings at a particular section.
 *
 * Deliberately not the remembered nav position. That one is a memory of where
 * somebody was, is only restored when "reopen last section" is on, and would
 * silently drop this request for anyone who has that off. This is where they
 * have just asked to be taken, so it is honoured either way.
 *
 * A module variable rather than storage: the request is consumed by the very
 * next mount of the settings screen, in the same page, so writing it to disk
 * would only create something to go stale.
 */
let requested: SettingsSectionId | null = null

export function requestSettingsSection(id: SettingsSectionId) {
  requested = id
}

/** Takes the pending request, if any. It is good exactly once. */
export function takeRequestedSettingsSection() {
  const id = requested
  requested = null

  return id
}
