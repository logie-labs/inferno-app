"use client"

import { createContext, useContext, useEffect, useState } from "react"

import { sections, type SectionKey } from "@/components/sections/index"
import { loadSettingsConfig } from "@/components/sections/settings/settings-config"

const activeSectionStorageKey = "inferno-app.active-section"
const defaultSection: SectionKey = "downloads"

function isSectionKey(value: string | null): value is SectionKey {
  return value !== null && value in sections
}

type ActiveSectionContextValue = {
  active: SectionKey
  setActive: (section: SectionKey) => void
}

const ActiveSectionContext = createContext<ActiveSectionContextValue | null>(
  null
)

export function ActiveSectionProvider({
  children,
  initialActive,
}: {
  children: React.ReactNode
  initialActive?: SectionKey
}) {
  const [active, setActive] = useState<SectionKey>(
    initialActive ?? defaultSection
  )

  // Restore on the client only - the server render has no localStorage, so
  // starting from the default keeps the markup stable through hydration. The
  // read is deferred a microtask so hydration commits before the swap.
  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    queueMicrotask(() => {
      if (!loadSettingsConfig().startup.reopenLastSection) {
        return
      }

      const storedSection = window.localStorage.getItem(activeSectionStorageKey)

      if (isSectionKey(storedSection)) {
        setActive(storedSection)
      } else if (storedSection !== null) {
        window.localStorage.setItem(activeSectionStorageKey, defaultSection)
      }
    })
  }, [])

  const updateActiveSection = (section: SectionKey) => {
    setActive(section)

    if (typeof window !== "undefined") {
      window.localStorage.setItem(activeSectionStorageKey, section)
    }
  }

  return (
    <ActiveSectionContext.Provider
      value={{ active, setActive: updateActiveSection }}
    >
      {children}
    </ActiveSectionContext.Provider>
  )
}

export function useActiveSection() {
  const context = useContext(ActiveSectionContext)

  if (!context) {
    throw new Error(
      "useActiveSection must be used within ActiveSectionProvider"
    )
  }

  return context
}
