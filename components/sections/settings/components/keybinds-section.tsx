"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RiCloseLine, RiRefreshLine } from "@remixicon/react"

import { Button } from "@/components/ui/button"
import { KeybindDisplay } from "@/components/keybind-display"
import {
  ConfirmDialog,
  type ConfirmRequest,
} from "@/components/confirm-dialog"
import { commandMap, commands, conflictFor, defaultKeybinds } from "@/lib/commands"
import {
  formatKeybind,
  isModifierCode,
  keybindFromEvent,
  modifierChord,
  needsModifier,
} from "@/lib/keybinds"
import { cn } from "@/lib/utils"

import type { SettingsSectionComponentProps } from "../settings-config"
import { SettingsFieldRow, SettingsPanel } from "./settings-primitives"

/**
 * Why a chord was refused, or null when it is fine.
 *
 * Returned rather than thrown so the row can say what is wrong in place, while
 * the recorder stays open for another try.
 */
function reject(
  bindings: Record<string, string>,
  commandId: string,
  binding: string
): string | null {
  if (needsModifier(binding)) {
    return "Needs Ctrl, Alt or Shift, or it would fire while typing."
  }

  const clash = conflictFor(bindings, commandId, binding)
  if (clash) {
    return `Already used by "${commandMap.get(clash)?.title ?? clash}".`
  }

  return null
}

/**
 * One row's recorder.
 *
 * While armed it swallows every key press, which is the whole point: the chord
 * being recorded is very often one that would otherwise do something, and the
 * user has to be able to record Ctrl+Alt+K without the palette opening on top
 * of the screen where they are setting it.
 */
function Recorder({
  commandId,
  bindings,
  onRecorded,
  onCancel,
}: {
  commandId: string
  bindings: Record<string, string>
  onRecorded: (binding: string) => void
  onCancel: () => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  /** The modifiers held right now, in case they turn out to be the whole chord. */
  const [held, setHeld] = useState("")
  const heldRef = useRef("")
  useEffect(() => {
    heldRef.current = held
  }, [held])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()

      if (event.code === "Escape") {
        onCancel()

        return
      }

      const binding = keybindFromEvent(event)
      if (!binding) {
        // Only modifiers so far. That may still be the whole answer - a tap
        // chord like Ctrl+Alt is legitimate - so it is settled on release
        // below rather than discarded here.
        setHeld(modifierChord(event))

        return
      }
      setHeld("")

      const problem = reject(bindings, commandId, binding)
      if (problem) {
        setProblem(problem)

        return
      }

      onRecorded(binding)
    }

    function onKeyUp(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()

      // Every modifier back up with nothing else pressed: they meant the tap.
      if (!isModifierCode(event.code) || modifierChord(event) !== "") {
        return
      }

      const candidate = heldRef.current
      setHeld("")
      if (!candidate) {
        return
      }

      const problem = reject(bindings, commandId, candidate)
      if (problem) {
        setProblem(problem)

        return
      }

      onRecorded(candidate)
    }

    // Capture, so these run before the app's own shortcut listener.
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)

    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
    }
  }, [bindings, commandId, onCancel, onRecorded])

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "min-w-40 border border-dashed px-3 py-1.5 text-center text-xs",
          problem ? "border-destructive text-destructive" : "border-ring"
        )}
      >
        {problem ?? (held ? formatKeybind(held) : "Press a shortcut…")}
      </span>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

export function KeybindsSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  const [recording, setRecording] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null)
  const bindings = config.keybinds

  const setBinding = useCallback(
    (commandId: string, binding: string) => {
      updateConfig((current) => ({
        ...current,
        keybinds: { ...current.keybinds, [commandId]: binding },
      }))
    },
    [updateConfig]
  )

  const restoreAll = useCallback(() => {
    updateConfig((current) => ({ ...current, keybinds: defaultKeybinds() }))
  }, [updateConfig])

  /**
   * Ask before restoring, and show what it is restoring *to*.
   *
   * A shortcut someone has customised is easy to lose to a stray click on an
   * icon, and the default is not something they can be expected to remember -
   * so the keys themselves are in the question rather than the word "default".
   */
  const confirmRestore = useCallback(
    (commandId: string, title: string, current: string, next: string) => {
      setConfirming({
        title: "Restore this shortcut?",
        description: (
          <>
            {title} will go back to <KeybindDisplay binding={next} empty="no shortcut" />
            {current ? (
              <>
                {" "}
                from its current <KeybindDisplay binding={current} />
              </>
            ) : null}
            .
          </>
        ),
        confirmLabel: "Restore",
        run: () => setBinding(commandId, next),
      })
    },
    [setBinding]
  )

  /**
   * Ask before unbinding.
   *
   * No keycaps in this one, unlike the restore question. Keys shown in a
   * dialog read as the keys you are choosing, so a chord next to "Remove"
   * suggests you are about to bind it - the opposite of what is happening.
   * The outcome is the answer here, and the outcome is that there is no
   * shortcut.
   *
   * Not marked destructive: the restore button sitting beside it puts the
   * default straight back, and spending the red treatment on something that
   * undone in one click leaves nothing louder for the things that cannot be.
   */
  const confirmClear = useCallback(
    (commandId: string, title: string) => {
      setConfirming({
        title: "Remove this shortcut?",
        description: `${title} will no longer have a keyboard shortcut. The command stays in the command menu.`,
        confirmLabel: "Remove",
        run: () => setBinding(commandId, ""),
      })
    },
    [setBinding]
  )

  return (
    <SettingsPanel
      title="Keyboard shortcuts"
      description="Every command in the command menu can be reached by a chord. Modifiers on their own work too - tap Ctrl+Alt and let go to open the menu."
    >
      {commands.map((command) => {
        const binding = bindings[command.id] ?? ""
        const isDefault = binding === command.defaultKeybind

        return (
          <SettingsFieldRow
            key={command.id}
            label={command.title}
            description={command.group}
          >
            {recording === command.id ? (
              <Recorder
                commandId={command.id}
                bindings={bindings}
                onRecorded={(next) => {
                  setBinding(command.id, next)
                  setRecording(null)
                }}
                onCancel={() => setRecording(null)}
              />
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRecording(command.id)}
                  className="min-w-40 border border-input px-3 py-1.5 text-center text-xs transition-colors hover:border-ring hover:bg-muted/40"
                >
                  <KeybindDisplay binding={binding} />
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Clear the shortcut for ${command.title}`}
                  disabled={!binding}
                  onClick={() =>
                    confirmClear(command.id, command.title)
                  }
                >
                  <RiCloseLine className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Restore the default shortcut for ${command.title}`}
                  disabled={isDefault}
                  onClick={() =>
                    confirmRestore(
                      command.id,
                      command.title,
                      binding,
                      command.defaultKeybind
                    )
                  }
                >
                  <RiRefreshLine className="size-3.5" />
                </Button>
              </div>
            )}
          </SettingsFieldRow>
        )
      })}

      <div className="flex justify-end pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setConfirming({
              title: "Restore all shortcuts?",
              description:
                "Every shortcut on this screen goes back to the one it shipped with. Anything you have customised is lost.",
              confirmLabel: "Restore all",
              destructive: true,
              run: restoreAll,
            })
          }
        >
          <RiRefreshLine data-icon="inline-start" className="size-3.5" />
          Restore all defaults
        </Button>
      </div>

      <ConfirmDialog
        request={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
          }
        }}
      />
    </SettingsPanel>
  )
}
