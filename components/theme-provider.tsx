"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

import { useSettingsConfig } from "@/components/sections/settings/settings-config"

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <ThemeSync />
      {children}
    </NextThemesProvider>
  )
}

/** Not in TypeScript's DOM lib yet, and absent in older webviews. */
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> }
}

/**
 * How every part of a theme change is timed. The only place it is written.
 *
 * The page and the chrome move on identical timing on purpose - they are one
 * gesture seen in two places, and a fade that finishes even slightly before the
 * scale it sits inside reads as two separate things happening.
 *
 * Every animation below is driven from here rather than from keyframes in CSS,
 * so this constant is the whole story: changing the duration or the easing
 * changes the page, the toolbar and the rail together. `globals.css` only names
 * the groups and switches the browser's own animations off.
 */
const THEME_TRANSITION = {
  duration: 480,
  easing: "cubic-bezier(0.19, 1, 0.22, 1)",
} as const

/**
 * The parts lifted out of the root snapshot, by transition name.
 *
 * These have to match the `view-transition-name` declarations in
 * `globals.css` - a name can only be assigned in CSS, so the pairing is the one
 * thing that genuinely lives in two files.
 */
const CHROME_GROUPS = ["inferno-toolbar", "inferno-sidebar"] as const

/**
 * The old window shrinking away as the new one grows in, with the chrome
 * holding still and only changing colour.
 *
 * Both halves of each group are animated. Animating only one leaves the other
 * sitting at the browser's default cross-fade, and the two read as a flicker
 * rather than as one movement.
 */
function playThemeTransition(root: HTMLElement) {
  root.animate(
    [
      { transform: "scale(0.99)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { ...THEME_TRANSITION, pseudoElement: "::view-transition-new(root)" }
  )
  root.animate(
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(1.01)", opacity: 0 },
    ],
    { ...THEME_TRANSITION, pseudoElement: "::view-transition-old(root)" }
  )

  // Chrome is pinned to an edge, so it changes colour where it stands rather
  // than scaling with the page.
  for (const name of CHROME_GROUPS) {
    root.animate([{ opacity: 0 }, { opacity: 1 }], {
      ...THEME_TRANSITION,
      pseudoElement: `::view-transition-new(${name})`,
    })
    root.animate([{ opacity: 1 }, { opacity: 0 }], {
      ...THEME_TRANSITION,
      pseudoElement: `::view-transition-old(${name})`,
    })
  }
}

/**
 * Which class next-themes is about to put on the root.
 *
 * Duplicated here for one reason: `setTheme` only sets React state, and
 * next-themes writes the class from a passive effect afterwards. A view
 * transition snapshots the DOM the moment its callback returns, so going
 * through `setTheme` alone captures the *old* theme twice and animates nothing.
 * Applying the class inside the callback puts the change where the snapshot can
 * see it; next-themes then sets the same class a beat later, which is a no-op.
 */
function resolveClass(theme: string) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  }

  return theme
}

/**
 * Applies the stored preference to next-themes, from wherever it is changed.
 *
 * The theme has one owner - `appearance.theme` in settings - and this is the
 * single place that owner is acted on, so a change made from the command menu
 * and one made from the Appearance screen behave identically.
 */
function ThemeSync() {
  const { theme, themeAnimation } = useSettingsConfig().appearance
  const { setTheme } = useTheme()

  // The theme on load is not a *change*, so it is applied without animation -
  // otherwise the app zooms itself in every time it starts.
  const settled = React.useRef(false)

  React.useEffect(() => {
    const first = !settled.current
    settled.current = true

    const root = document.documentElement
    const target = resolveClass(theme)
    const unchanged = root.classList.contains(target)
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    const start = (document as ViewTransitionDocument).startViewTransition

    if (first || unchanged || !themeAnimation || reduced || !start) {
      setTheme(theme)

      return
    }

    start
      .call(document, () => {
        setTheme(theme)
        root.classList.remove("light", "dark")
        root.classList.add(target)
      })
      .ready.then(() => playThemeTransition(root))
      // A transition can be skipped - another one starting, the tab hiding -
      // and that rejects `ready`. The theme has still been applied, so there is
      // nothing to recover from and nothing worth logging.
      .catch(() => {})
  }, [setTheme, theme, themeAnimation])

  return null
}

export { ThemeProvider }
