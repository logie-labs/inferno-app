"use client"

import { useState } from "react"

import { RiAddLine, RiFolderOpenLine, RiSearchLine, RiTimeLine } from "@remixicon/react"

import { useFileBrowser } from "@/components/sections/downloads/file-browser-dialog"
import {
  setSessionDestination,
  useSessionDestination,
  type DownloadFolder,
} from "@/components/sections/settings/settings-config"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { capabilities } from "@/lib/deployment"
import { cn } from "@/lib/utils"

/**
 * Where this download goes, as one control rather than a path field.
 *
 * The list is the one in Settings, not a copy of it: picking here sets the
 * same `downloads.location` that screen edits, and adding here adds to the
 * same `downloads.folders` it lists. Two views of one setting, which is what
 * "linked" has to mean if they are never to disagree.
 *
 * Two entries are not folders in that list:
 *
 * - **the service's own folder**, which is where files already are. Selecting
 *   it means "leave it there", stored as an empty location - the same thing an
 *   empty field used to mean, now with a name.
 * - **just this once**, a path used for the next download and never written to
 *   settings. See `setSessionDestination` for why that lives outside them.
 */
export function SaveToSelect({
  value,
  folders,
  serviceDirectory,
  onValueChange,
  onAddFolder,
  disabled,
  className,
}: {
  /** The stored location. Empty means the service's own folder. */
  value: string
  folders: readonly DownloadFolder[]
  serviceDirectory: string | null
  onValueChange: (path: string) => void
  /** Adds to the list in settings, so the choice is there next time. */
  onAddFolder: (path: string) => void
  disabled?: boolean
  className?: string
}) {
  const [adding, setAdding] = useState<"save" | "once" | null>(null)
  const session = useSessionDestination()

  const stored = value.trim()

  /**
   * The list, as ids rather than paths.
   *
   * Ids because two of these entries are not folders at all, and the first
   * attempt gave those NUL-prefixed pseudo-paths on the grounds that no real
   * path contains a NUL. True, and still wrong: the value is rendered into the
   * markup, so a NUL ended up in the prerendered HTML and made the page a
   * binary file to anything reading it as text. An id has no such problem and
   * says what it is.
   */
  const options: { id: string; path: string | null; label: string }[] = [
    {
      id: "service",
      path: null,
      label: serviceDirectory
        ? `The service's folder · ${folderName(serviceDirectory)}`
        : "The service's own folder",
    },
    ...folders.map((folder, index) => ({
      id: `folder-${index}`,
      path: folder.path,
      label: folderName(folder.path),
    })),
  ]

  // Only while it is set: it is not a choice to make from cold, it is the one
  // being used.
  if (session) {
    options.push({
      id: "session",
      path: session,
      label: `${folderName(session)} · just this once`,
    })
  }

  // A stored location that is not on the list any more - removed in Settings,
  // say - still has to show as what is selected rather than silently reading
  // as the service's folder.
  if (stored && !session && !options.some((item) => item.path === stored)) {
    options.push({ id: "stored", path: stored, label: folderName(stored) })
  }

  const selected = session
    ? "session"
    : (options.find((item) => item.path === stored)?.id ?? "service")

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <Select
        value={selected}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === null) {
            return
          }
          if (next === "add" || next === "once") {
            setAdding(next === "once" ? "once" : "save")

            return
          }
          const chosen = options.find((item) => item.id === next)
          if (!chosen) {
            return
          }
          // Choosing from the list ends a "just this once", which is otherwise
          // invisible and would go on winning.
          setSessionDestination(null)
          onValueChange(chosen.path ?? "")
        }}
      >
        <SelectTrigger className="min-w-0 flex-1">
          {/* Base UI renders the raw value, which here is an id. */}
          <SelectValue placeholder="Choose a folder">
            {options.find((item) => item.id === selected)?.label}
          </SelectValue>
        </SelectTrigger>

        <SelectContent className="max-w-100">
          {options.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.id === "session" ? (
                <RiTimeLine data-icon="inline-start" />
              ) : null}
              <span className="min-w-0 truncate">{item.label}</span>
            </SelectItem>
          ))}

          <SelectSeparator />

          <SelectItem value="add">
            <RiAddLine data-icon="inline-start" />
            Add a folder…
          </SelectItem>
          <SelectItem value="once">
            <RiTimeLine data-icon="inline-start" />
            Somewhere just this once…
          </SelectItem>
        </SelectContent>
      </Select>

      <PathDialog
        mode={adding}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(null)
          }
        }}
        onChosen={(path) => {
          if (adding === "once") {
            // Not added to the list and not stored: used for the next download
            // and forgotten when the tab closes.
            setSessionDestination(path)
          } else {
            setSessionDestination(null)
            onAddFolder(path)
            onValueChange(path)
          }
          setAdding(null)
        }}
      />
    </div>
  )
}

/** The last segment of a path, whichever slash the platform uses. */
function folderName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  )
}

/**
 * Type a path, or go and find one.
 *
 * Both, because they answer different questions: pasting is the quick way when
 * you know where it is, and the browser is for when you do not.
 *
 * They finish differently, though. A typed path is half-done until confirmed,
 * so it has a button. A folder chosen in the picker has already been confirmed
 * - you navigated to it and pressed the button naming it - so it is taken as
 * the answer and this closes.
 */
function PathDialog({
  mode,
  onOpenChange,
  onChosen,
}: {
  mode: "save" | "once" | null
  onOpenChange: (open: boolean) => void
  onChosen: (path: string) => void
}) {
  const [path, setPath] = useState("")
  const fileBrowser = useFileBrowser()

  const trimmed = path.trim()
  const once = mode === "once"

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPath("")
        }
        onOpenChange(open)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {once ? "Save somewhere just this once" : "Add a folder"}
          </DialogTitle>
          <DialogDescription>
            {once
              ? "Used for the next download and not remembered - it is gone when this tab closes."
              : "Added to your save locations, so it is here next time too."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed) {
              onChosen(trimmed)
              setPath("")
            }
          }}
        >
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="Paste or type a path"
              spellCheck={false}
              className="min-w-0 flex-1 font-mono text-[11px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              title={
                capabilities.localFilesystem
                  ? "Choose a folder"
                  : "Find it in the file browser"
              }
              aria-label="Choose a folder"
              onClick={() => {
                // Answers outright rather than filling the field: navigating
                // to a folder and pressing the button that names it is the
                // choice being made, and asking for a second confirmation
                // reads as the first one not having worked.
                void fileBrowser.pickFolder().then((picked) => {
                  if (picked) {
                    onChosen(picked)
                    setPath("")
                  }
                })
              }}
            >
              {capabilities.localFilesystem ? (
                <RiFolderOpenLine />
              ) : (
                <RiSearchLine />
              )}
            </Button>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!trimmed}>
              {once ? "Use it once" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
