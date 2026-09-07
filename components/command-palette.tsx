"use client"

/**
 * The command menu, and the one global key listener behind it.
 *
 * Both halves live together because they are the same decision made twice: a
 * command is either picked from the list or reached by its chord, and neither
 * route should be able to do something the other cannot. The provider owns the
 * id -> handler map; `lib/commands.ts` owns the list and the default chords.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { KeybindDisplay } from "@/components/keybind-display"
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useActiveSection } from "@/components/sections/active-section-context"
import { sectionOrder } from "@/components/sections/section-meta"
import {
  loadSettingsConfig,
  saveSettingsConfig,
  useSettingsConfig,
} from "@/components/sections/settings/settings-config"
import { requestSettingsSection } from "@/components/sections/settings/settings-navigation"
import { requestUpdateCheck } from "@/lib/updates"
import type { DownloadOptions } from "@/components/sections/downloads/download-options"
import { commands, type CommandGroup as Group } from "@/lib/commands"
import { SPOTIFY_AUDIO_FORMAT, spotifyDeliveryReady } from "@/lib/spotify"
import { RiMusic2Line, RiSpotifyLine, RiVideoLine } from "@remixicon/react"
import {
  isModifierCode,
  isModifierOnly,
  isTypingTarget,
  matchesKeybind,
  modifierChord,
} from "@/lib/keybinds"

/**
 * Whether what has been typed is a link worth offering to download.
 *
 * Deliberately shallow: it checks that this is an http(s) URL with a host, and
 * leaves "can yt-dlp actually take it" to the service, which is the only thing
 * that really knows. Guessing at a list of supported sites here would go stale
 * and would refuse links that work.
 */
function linkIn(query: string): string | null {
  const text = query.trim()
  if (!text || /\s/.test(text)) {
    return null
  }

  try {
    const url = new URL(text)

    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/** Rendered in this order, whatever order the registry happens to be in. */
const GROUP_ORDER: Group[] = ["Go to", "Downloads", "Appearance", "App"]

/**
 * Commands the app can run right now.
 *
 * Anything the palette cannot currently do is simply absent rather than
 * disabled - the download actions need the downloads screen's own context, so
 * they are dispatched to it as events instead of reaching across into it.
 */
function useCommandHandlers() {
  const { setActive } = useActiveSection()
  const { resolvedTheme } = useTheme()

  /**
   * Ask the downloads screen to do something, if it is listening.
   *
   * A window event rather than a shared context: the queue's controls belong to
   * a screen that is not mounted most of the time, and hoisting its state up to
   * the app root just so a shortcut can reach it would make every download tick
   * re-render the whole tree.
   */
  const toDownloads = useCallback(
    (action: string, description: string) => {
      setActive("downloads")
      // After the section has mounted, so a listener that only exists on that
      // screen is there to hear it.
      requestAnimationFrame(() => {
        const delivered = window.dispatchEvent(
          new CustomEvent("inferno-app:queue-action", {
            detail: action,
            cancelable: true,
          })
        )
        if (delivered) {
          toast.info(description)
        }
      })
    },
    [setActive]
  )

  const download = useCallback(
    (
      url: string,
      mode: "video" | "audio",
      // For a command that decides the download itself rather than taking
      // whatever the panel happens to be set to.
      options?: Partial<DownloadOptions>
    ) => {
      setActive("downloads")
      requestAnimationFrame(() => {
        const delivered = window.dispatchEvent(
          new CustomEvent("inferno-app:queue-url", {
            detail: { url, mode, options },
            cancelable: true,
          })
        )
        if (!delivered) {
          toast.error("The downloads screen is not ready yet.")
        }
      })
    },
    [setActive]
  )

  const setThemePreference = useCallback(
    (theme: "light" | "dark" | "system") => {
      const current = loadSettingsConfig()
      saveSettingsConfig({
        ...current,
        appearance: { ...current.appearance, theme },
      })
    },
    []
  )

  const handlers = useMemo<Record<string, () => void>>(
    () => ({
      "palette.open": () => {},
      // One per section, matching the generated `go.*` commands.
      ...Object.fromEntries(
        sectionOrder.map((key) => [`go.${key}`, () => setActive(key)])
      ),
      "downloads.openFolder": () =>
        toDownloads("open-folder", "Opening the download folder"),
      "downloads.retryErrors": () =>
        toDownloads("retry-errors", "Retrying failed downloads"),
      "downloads.clearFinished": () =>
        toDownloads("clear-finished", "Cleared finished downloads"),
      "downloads.cancelAll": () =>
        toDownloads("cancel-all", "Cancelling downloads"),
      // Dispatched rather than run here. The check belongs to the watcher at
      // the app root, which already owns the schedule and the notification -
      // and asking for the service's health from the palette would subscribe
      // it to the whole download context to do it.
      "app.checkForUpdates": () => {
        requestSettingsSection("updates")
        setActive("settings")
        requestUpdateCheck()
      },
      // Written to settings, not handed straight to next-themes. The stored
      // preference is what the app applies on load and what the Appearance
      // screen shows, so setting the theme without recording it would last
      // until the next reload and quietly disagree with the screen meanwhile.
      "appearance.toggleTheme": () =>
        setThemePreference(resolvedTheme === "dark" ? "light" : "dark"),
      "appearance.system": () => setThemePreference("system"),
    }),
    [resolvedTheme, setActive, setThemePreference, toDownloads]
  )

  return { handlers, download }
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const config = useSettingsConfig()
  const { handlers, download } = useCommandHandlers()
  const bindings = config.keybinds

  // Read through a ref inside the listener so the shortcut does not tear down
  // and rebind on every settings change or theme flip. Written in an effect
  // rather than during render - a render can be thrown away and restarted, and
  // a ref written on the attempt that lost would be quietly wrong.
  const latest = useRef({ bindings, handlers })
  useEffect(() => {
    latest.current = { bindings, handlers }
  }, [bindings, handlers])

  useEffect(() => {
    /**
     * The command a modifier-only chord just fired, until the keys come back up.
     *
     * Modifier chords open on *press*, so Ctrl+Alt shows the menu the instant
     * it is held rather than making you let go first. The cost is that a longer
     * chord starts by satisfying the shorter one - Ctrl+Alt+O opens the menu on
     * its way to opening the folder - so this remembers what was fired
     * speculatively, and the longer chord takes it back below.
     */
    let speculative: string | null = null

    const fire = (commandId: string) => {
      const { handlers: run } = latest.current

      if (commandId === "palette.open") {
        setOpen((wasOpen) => !wasOpen)

        return
      }

      setOpen(false)
      run[commandId]?.()
    }

    const commandFor = (predicate: (binding: string) => boolean) => {
      const { bindings: current } = latest.current

      return commands.find((command) => {
        const binding = current[command.id]

        return Boolean(binding) && predicate(binding)
      })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (isModifierCode(event.code)) {
        // Fire the moment the modifiers are all down. Nothing is committed
        // that a longer chord cannot undo, so there is no reason to wait.
        const held = modifierChord(event)
        const match = commandFor(
          (binding) => isModifierOnly(binding) && binding === held
        )
        if (match) {
          event.preventDefault()
          speculative = match.id
          fire(match.id)
        }

        return
      }

      const match = commandFor(
        (binding) => !isModifierOnly(binding) && matchesKeybind(event, binding)
      )
      if (!match) {
        // A key that completes nothing still ends the speculation - the
        // modifiers were the start of typing, not a chord.
        speculative = null

        return
      }

      const binding = latest.current.bindings[match.id]
      // A chord with modifiers is safe over a text field; a bare one is not,
      // and would eat the keystroke someone meant to type.
      if (!binding.includes("+") && isTypingTarget(event.target)) {
        return
      }

      event.preventDefault()
      // This chord was built on top of one already fired speculatively; the
      // longer one is what they meant, so put the shorter one back first.
      if (speculative === "palette.open") {
        setOpen(false)
      }
      speculative = null
      fire(match.id)
    }

    function onKeyUp(event: KeyboardEvent) {
      if (isModifierCode(event.code) && modifierChord(event) === "") {
        speculative = null
      }
    }

    // A chord interrupted by the window going away leaves no keyup behind.
    const forget = () => {
      speculative = null
    }

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", forget)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", forget)
    }
  }, [])

  const link = linkIn(query)

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => ({
      group,
      // The palette is a list of things to do; "open the command menu" is not
      // one of them once you are looking at it.
      items: commands.filter(
        (command) => command.group === group && command.id !== "palette.open"
      ),
    })).filter((entry) => entry.items.length > 0)
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery("")
        }
      }}
      className="sm:max-w-lg"
    >
      <Command loop>
        <CommandInput
          placeholder="Type a command, or paste a link…"
          value={query}
          onValueChange={setQuery}
          autoFocus
        />
        <CommandList>
          {/* A URL matches no command by design, so the empty state would
              contradict the two items sitting right above it. */}
          {link ? null : <CommandEmpty>No matching command.</CommandEmpty>}
          {link ? (
            // `forceMount` and a `value` of the raw link: cmdk filters on the
            // typed text, and a URL never scores against a command's title, so
            // without this the two most relevant items would be filtered out
            // by the very thing that made them relevant.
            <CommandGroup heading="This link" forceMount>
              <CommandItem
                forceMount
                value={link}
                onSelect={() => {
                  setOpen(false)
                  download(link, "video")
                }}
              >
                <RiVideoLine className="size-3.5 text-muted-foreground" />
                Download as video
              </CommandItem>
              <CommandItem
                forceMount
                value={`${link} audio`}
                onSelect={() => {
                  setOpen(false)
                  download(link, "audio")
                }}
              >
                <RiMusic2Line className="size-3.5 text-muted-foreground" />
                Download as audio
              </CommandItem>
              {/* Only with somewhere to put it - the same rule the download
                  pane uses, from the same function. Its format and bitrate
                  come from settings rather than from the panel: this route
                  never shows the panel, and a command that quietly inherited
                  whatever was left there last would deliver a different file
                  each time. */}
              {spotifyDeliveryReady(config.spotify) ? (
                <CommandItem
                  forceMount
                  value={`${link} spotify`}
                  onSelect={() => {
                    setOpen(false)
                    download(link, "audio", {
                      spotify: true,
                      audioFormat: SPOTIFY_AUDIO_FORMAT,
                      audioQuality: config.spotify.quickBitrateKbps,
                    })
                  }}
                >
                  <RiSpotifyLine className="size-3.5 text-muted-foreground" />
                  Add to Spotify
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}
          {grouped.map(({ group, items }) => (
            <CommandGroup key={group} heading={group}>
              {items.map((command) => (
                <CommandItem
                  key={command.id}
                  value={`${command.title} ${command.keywords ?? ""}`}
                  onSelect={() => {
                    setOpen(false)
                    handlers[command.id]?.()
                  }}
                >
                  <command.icon className="size-3.5 text-muted-foreground" />
                  {command.title}
                  {bindings[command.id] ? (
                    <CommandShortcut>
                      <KeybindDisplay binding={bindings[command.id]} />
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
