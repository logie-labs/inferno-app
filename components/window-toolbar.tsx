"use client"

import { useEffect, useState } from "react"

import { usePathname } from "next/navigation"

import { Icon, type IconName } from "@/components/icon"
import { useActiveSection } from "@/components/sections/active-section-context"
import { sectionLabels } from "@/components/sections/index"
import { tauriWindow } from "@/lib/tauri-window"
import { cn } from "@/lib/utils"
import { RiFireLine } from "@remixicon/react"

function WindowControlButton({
  label,
  glyph,
  onClick,
  danger = false,
}: {
  label: string
  glyph: IconName
  onClick: () => Promise<void>
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-full w-11.25 items-center justify-center bg-transparent text-foreground transition-colors",
        "hover:bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] active:bg-[color-mix(in_oklab,var(--foreground)_14%,transparent)]",
        danger &&
          "hover:bg-red-600 hover:text-[oklch(0.98_0_0)] active:bg-[color-mix(in_oklab,var(--destructive)_92%,transparent)]"
      )}
    >
      <Icon name={glyph} className="text-[10px]" />
    </button>
  )
}

/**
 * The label sitting next to the wordmark. On the shell route that is whichever
 * section the rail has selected; on a standalone route it is the route itself,
 * so the toolbar never claims you are somewhere you are not.
 */
function usePageLabel() {
  const pathname = usePathname()
  const { active } = useActiveSection()

  if (pathname === "/") {
    return sectionLabels[active]
  }

  return pathname.replace(/^\//, "").replace(/[/-]/g, " ")
}

export function WindowToolbar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const label = usePageLabel()

  useEffect(() => {
    let mounted = true

    const syncWindowState = async () => {
      const maximized = await tauriWindow.isMaximized()

      if (mounted) {
        setIsMaximized(maximized)
      }
    }

    void syncWindowState()
    const cleanupResize = tauriWindow.onResize(() => {
      void syncWindowState()
    })

    return () => {
      mounted = false
      cleanupResize()
    }
  }, [])

  return (
    // `relative z-100` keeps the caption above every portalled layer (dialog
    // overlay and its backdrop blur, dropdowns, toasts) so it is never dimmed
    // or blurred. `pointer-events-auto` re-enables it against the
    // `pointer-events: none` Radix puts on <body> for a modal dialog - the
    // window controls have to keep working whatever is open.
    //
    // `inferno-vt-toolbar` gives the bar its own view-transition group, so it
    // is lifted out of the root snapshot and animated separately when the
    // theme changes - the page scales, the toolbar only changes colour. See
    // `globals.css`.
    <header className="inferno-vt-toolbar pointer-events-auto relative z-100 grid h-(--inferno-toolbar-height) shrink-0 grid-cols-[1fr_auto] items-center border-b bg-[color-mix(in_oklab,var(--background)_94%,var(--foreground)_6%)] select-none">
      <div
        className="flex h-full items-center gap-2.5 px-3"
        data-tauri-drag-region
      >
        {/* <span className="font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
          inferno
        </span> */}
        <RiFireLine className="pointer-events-none size-4 tracking-[0.12em] text-muted-foreground" />
        <span
          aria-hidden
          className="pointer-events-none size-0.75 rounded-full bg-foreground/25"
        />
        <span
          key={label}
          className="pointer-events-none animate-in font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase duration-200 fade-in-0"
        >
          {label}
        </span>
      </div>
      <div className="flex h-full items-stretch">
        <WindowControlButton
          label="Minimise"
          glyph="minimize"
          onClick={tauriWindow.minimize}
        />
        <WindowControlButton
          label={isMaximized ? "Restore" : "Maximise"}
          glyph={isMaximized ? "restore" : "maximize"}
          onClick={tauriWindow.toggleMaximize}
        />
        <WindowControlButton
          label="Close"
          glyph="close"
          onClick={tauriWindow.close}
          danger
        />
      </div>
    </header>
  )
}
