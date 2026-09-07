"use client"

import { useEffect, useState } from "react"
import {
  RiAlertLine,
  RiCheckLine,
  RiExternalLinkLine,
  RiFolderAddLine,
  RiFolderOpenLine,
} from "@remixicon/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  checkDirectory,
  openPath,
  pickDirectory,
  type DirectoryCheck,
} from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

/**
 * How long typing settles before the disk is touched.
 *
 * The check itself is a probe file and an IPC hop - fractions of a
 * millisecond - so this number *is* the wait. Long enough not to probe on
 * every keystroke of a fast typist, short enough that pausing feels like an
 * answer rather than a delay.
 */
const SETTLE = 150

/**
 * How each answer is shown.
 *
 * "Does not exist" is deliberately not an error. Typing the folder you want and
 * having it made for you is the normal way to do this, and colouring it red
 * would send people back to fix something that is not broken.
 */
const TONE: Record<
  DirectoryCheck["status"],
  { className: string; icon: typeof RiCheckLine }
> = {
  ok: { className: "text-muted-foreground", icon: RiCheckLine },
  will_create: { className: "text-sky-700 dark:text-sky-400", icon: RiFolderAddLine },
  not_a_directory: { className: "text-destructive", icon: RiAlertLine },
  unwritable: { className: "text-destructive", icon: RiAlertLine },
  no_parent: { className: "text-destructive", icon: RiAlertLine },
  invalid: { className: "text-destructive", icon: RiAlertLine },
}

/**
 * A folder path, typed by hand, with the disk's opinion underneath.
 *
 * The check runs on the Rust side and writes a probe file, so it is debounced
 * rather than run per keystroke - and it runs on what has been typed, not on
 * what has been saved, so the answer is about the path in front of you.
 */
export function FolderField({
  value,
  onValueChange,
  placeholder,
  fallback,
  emptyHint,
  className,
}: {
  value: string
  onValueChange: (next: string) => void
  placeholder?: string
  /**
   * The folder used when the field is left empty.
   *
   * Not decoration: an empty field is not "no folder", it is *that* folder, so
   * this is what the buttons act on and what the check is run against. It
   * doubles as the placeholder, since naming the folder you will get is
   * exactly what a placeholder is for.
   */
  fallback?: string
  /** Shown instead of a check when the field is empty. */
  emptyHint?: string
  className?: string
}) {
  const [check, setCheck] = useState<{
    path: string
    result: DirectoryCheck
  } | null>(null)

  const typed = value.trim()
  /** What this field actually resolves to, which is what the buttons act on. */
  const target = typed || fallback?.trim() || ""

  useEffect(() => {
    if (!target) {
      return
    }

    let live = true
    const timer = setTimeout(() => {
      void checkDirectory(target).then((result) => {
        if (live && result) {
          setCheck({ path: target, result })
        }
      })
    }, SETTLE)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [target])

  // Keyed by the path it describes, so a slow answer about a path that has
  // since been edited is never shown against the new one.
  const current = check?.path === target ? check.result : null
  // Only against something typed: a verdict on the fallback belongs to the
  // sentence naming it, not to a tick beside an empty field.
  const tone = typed && current ? TONE[current.status] : null

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex min-w-0 items-center gap-1">
        <Input
          value={value}
          placeholder={placeholder ?? fallback}
          spellCheck={false}
          onChange={(event) => onValueChange(event.target.value)}
          className="min-w-0 flex-1"
        />

        {/* Typing is the quick way once you know the path; the picker is for
            when you do not. Both are here so neither is a detour. */}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          title="Choose a folder"
          aria-label="Choose a folder"
          onClick={() => {
            void pickDirectory(target).then((picked) => {
              if (picked) {
                onValueChange(picked)
              }
            })
          }}
        >
          <RiFolderOpenLine />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          // Against the resolved folder, so an empty field opens the one it
          // falls back to rather than refusing on the grounds that nothing
          // was typed. Still only once it is known to be there: opening a
          // folder that has not been created yet fails in a dialog nobody
          // asked for.
          disabled={current?.status !== "ok"}
          title={
            current?.status === "ok"
              ? `Open ${target}`
              : "There is nothing to open yet"
          }
          aria-label="Open this folder"
          onClick={() => void openPath(target)}
        >
          <RiExternalLinkLine />
        </Button>
      </div>

      {/* The row is always here, so nothing jumps when an answer arrives. */}
      <p
        className={cn(
          "flex min-h-4 items-start gap-1.5 text-[10px] leading-snug",
          tone?.className ?? "text-muted-foreground"
        )}
      >
        {tone ? <tone.icon className="mt-px size-3 shrink-0" /> : null}
        {typed
          ? (current?.message ?? "Checking…")
          : (emptyHint ??
            (fallback
              ? `Empty saves to ${fallback}`
              : "Leave empty to use the service's own folder."))}
      </p>
    </div>
  )
}
