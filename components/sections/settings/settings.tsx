"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { takeRequestedSettingsSection } from "./settings-navigation"

import { toast } from "sonner"

import { RiSearchLine } from "@remixicon/react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"

import { SettingsSidebar } from "./components/settings-sidebar"
import {
  createDefaultSettingsConfig,
  loadSettingsConfig,
  saveSettingsConfig,
  useSettingsConfig,
  type SettingsConfig,
} from "./settings-config"
import { buildSettingsIndex, scoreSection } from "./settings-search"
import {
  settingsNavGroups,
  settingsSectionMap,
  type SettingsNavGroup,
  type SettingsSectionId,
} from "./settings-registry"

const activeSettingsSectionStorageKey = "inferno-app.settings.active-section"
const defaultSettingsSection: SettingsSectionId = "appearance"

/** Width below which the settings nav drops to an icon-only rail. */
const collapseBelowPx = 820

function flattenGroups(groups: SettingsNavGroup[]) {
  return groups.flatMap((group) => group.items)
}

function isSettingsSectionId(value: string | null): value is SettingsSectionId {
  return value !== null && value in settingsSectionMap
}

export default function SettingsSection() {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState("")
  const [activeId, setActiveId] = useState<SettingsSectionId>(
    defaultSettingsSection
  )
  // The shared store, not a copy of it. A local copy meant two places
  // believed they owned the settings, and whichever wrote last won - which is
  // how a theme picked from the command menu could be quietly undone by this
  // screen re-saving the values it had loaded earlier.
  const config = useSettingsConfig()
  const [isHydrated, setIsHydrated] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

  const updateConfig = useCallback(
    (updater: (current: SettingsConfig) => SettingsConfig) => {
      // Read-modify-write against storage rather than against a render-time
      // value, so an update cannot be based on a snapshot that something else
      // has already moved on from.
      saveSettingsConfig(updater(loadSettingsConfig()))
    },
    []
  )

  // Only the nav position is restored here now - the settings themselves come
  // from the store, which reads storage itself. Deferred a microtask so the
  // first client render still matches what was prerendered.
  //
  // The theme is applied by `ThemeSync` at the app root rather than here: it
  // has to keep working when this screen is not on it.
  useEffect(() => {
    queueMicrotask(() => {
      // Somewhere asked for a particular section - a right-click on the
      // Spotify block in the download pane, say. That beats both the
      // remembered position and the preference governing it.
      const requested = takeRequestedSettingsSection()

      if (requested) {
        setActiveId(requested)
      } else if (
        loadSettingsConfig().startup.reopenLastSection &&
        typeof window !== "undefined"
      ) {
        const storedSection = window.localStorage.getItem(
          activeSettingsSectionStorageKey
        )

        if (isSettingsSectionId(storedSection)) {
          setActiveId(storedSection)
        }
      }

      setIsHydrated(true)
    })
  }, [])

  useEffect(() => {
    if (!isHydrated || typeof window === "undefined") {
      return
    }

    window.localStorage.setItem(activeSettingsSectionStorageKey, activeId)
  }, [activeId, isHydrated])

  // Collapse against the shell's own width, not the viewport - the section
  // shares the window with the app rail.
  useEffect(() => {
    const element = shellRef.current

    if (!element) {
      return
    }

    const updateCollapsedState = () => {
      setIsSidebarCollapsed(
        element.getBoundingClientRect().width < collapseBelowPx
      )
    }

    updateCollapsedState()

    const observer = new ResizeObserver(updateCollapsedState)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const resetSettings = useCallback(() => {
    saveSettingsConfig(createDefaultSettingsConfig())
    toast.success("Settings reset to defaults")
  }, [])

  // Rebuilt only when the values themselves change, not on every keystroke.
  const index = useMemo(
    () => buildSettingsIndex(flattenGroups(settingsNavGroups), config),
    [config]
  )

  const scores = useMemo(() => {
    const byId = new Map<SettingsSectionId, number>()
    for (const entry of index) {
      byId.set(entry.id, scoreSection(entry, query))
    }

    return byId
  }, [index, query])

  // Groups keep their order and their headings; only the sections inside them
  // are ranked. Reordering the groups as well would move Appearance under
  // Advanced on some queries, and the nav would stop being a place you can
  // learn the shape of.
  const filteredGroups = useMemo(
    () =>
      settingsNavGroups
        .map((group) => ({
          ...group,
          items: group.items
            .filter((item) => (scores.get(item.id) ?? 0) > 0)
            .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)),
        }))
        .filter((group) => group.items.length > 0),
    [scores]
  )

  const visibleItems = useMemo(
    () => flattenGroups(filteredGroups),
    [filteredGroups]
  )

  const selectedId =
    visibleItems.find((item) => item.id === activeId)?.id ?? visibleItems[0]?.id
  const activeItem = selectedId ? settingsSectionMap[selectedId] : undefined

  return (
    <div ref={shellRef} className="flex h-full min-h-0 overflow-hidden">
      <SettingsSidebar
        activeId={selectedId ?? activeId}
        query={query}
        onQueryChange={setQuery}
        onSelectSection={setActiveId}
        groups={filteredGroups}
        collapsed={isSidebarCollapsed}
      />

      {/* A flex column with `min-h-0`, not an absolutely positioned box. The
          ScrollArea's viewport is `h-full`, which only resolves against an
          ancestor with a definite height - and `min-h-0` is what stops a flex
          item refusing to shrink below its content, which is the usual reason
          a pane like this grows instead of scrolling. This is the same shape
          the queue panel uses, which has always scrolled correctly. */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeItem ? (
          <ScrollArea
            key={activeItem.id}
            className="min-h-0 flex-1 animate-in duration-200 fade-in-0 slide-in-from-bottom-1"
          >
            {/* Full width: the shell is already narrow next to the app rail and
                the settings nav, so capping it again wasted most of the pane. */}
            <div className="flex w-full flex-col gap-6 p-6">
              {isHydrated ? (
                <activeItem.component
                  config={config}
                  updateConfig={updateConfig}
                  resetSettings={resetSettings}
                />
              ) : null}
            </div>
          </ScrollArea>
        ) : (
          <Empty className="m-auto h-fit max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiSearchLine />
              </EmptyMedia>
              <EmptyTitle>No matches</EmptyTitle>
              <EmptyDescription>
                No settings sections match &quot;{query}&quot;.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </main>
    </div>
  )
}
