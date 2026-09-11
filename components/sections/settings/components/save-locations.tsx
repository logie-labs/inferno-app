"use client"

import { useEffect, useMemo, useState } from "react"
import {
  RiAddLine,
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiFolderOpenLine,
  RiHardDrive2Line,
  RiTimeLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FolderField } from "@/components/ui/folder-field"
import {
  checkDirectory,
  knownFolders,
  openPath,
  type DirectoryCheck,
  type KnownFolder,
} from "@/lib/inferno-service"
import { capabilities } from "@/lib/deployment"
import { cn } from "@/lib/utils"

import { useInfernoService } from "@/components/sections/downloads/service-context"
import type {
  DownloadFolder,
  SettingsSectionComponentProps,
} from "../settings-config"

/**
 * The folder id whose files are not meant to survive.
 *
 * Singled out because it is the one row where "this folder does not exist
 * yet" is the normal state rather than something to point out, and the one
 * where somebody should be told what they are choosing before they choose it.
 */
const TEMPORARY = "temporary"

/**
 * What each verdict looks like on a row.
 *
 * "Does not exist" is deliberately not an error, the same as in `FolderField`:
 * naming the folder you want and having it made for you is the ordinary way
 * to do this.
 */
const STATUS_TONE: Record<DirectoryCheck["status"], string> = {
  ok: "text-muted-foreground",
  will_create: "text-sky-700 dark:text-sky-400",
  not_a_directory: "text-destructive",
  unwritable: "text-destructive",
  no_parent: "text-destructive",
  invalid: "text-destructive",
}

/**
 * Ask the disk about several folders at once.
 *
 * Keyed on the joined paths rather than the array, because a new array with
 * the same paths in it is not a reason to write probe files again - and this
 * component re-renders on every progress frame while a download runs.
 */
function useDirectoryChecks(paths: readonly string[]) {
  // Needed for the browser branch below, where the answer comes from the
  // service rather than from Rust.
  const { client } = useInfernoService()
  // Joined on NUL, not a space: `C:\Users\me\My Folder` is an ordinary
  // path, and splitting that on spaces would probe three folders that do
  // not exist. NUL is the one byte a path cannot contain.
  const key = paths.filter(Boolean).join("\u0000")
  const [checks, setChecks] = useState<Record<string, DirectoryCheck>>({})

  useEffect(() => {
    // No early return for an empty list: clearing state in the body of an
    // effect causes a cascading render, and there is nothing to clear
    // anyway. Answers are looked up by path, so ones left over from a row
    // that has gone are never read.
    const wanted = key ? key.split("\u0000") : []

    let live = true

    void Promise.all(
      wanted.map(
        async (path) =>
          [
            path,
            // Same split as `FolderField`: the desktop asks Rust, the browser
            // asks the service. Without the second branch every row here sat
            // on "Checking…" for ever in the container, because the Tauri call
            // answers null there and null reads as "still waiting".
            capabilities.localFilesystem
              ? await checkDirectory(path)
              : ((await client?.checkFolder(path)) ?? null),
          ] as const
      )
    ).then((answers) => {
      if (!live) {
        return
      }

      setChecks(
        Object.fromEntries(
          answers.flatMap(([path, result]) =>
            result ? [[path, result] as const] : []
          )
        )
      )
    })

    return () => {
      live = false
    }
  }, [key, client])

  return checks
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
 * One folder in the list.
 *
 * The whole label area selects, rather than a small radio nobody aims at, and
 * the two controls on the right sit outside that button - a button inside a
 * button is not a thing, and the row has to be pressable.
 */
function FolderRow({
  path,
  label,
  active,
  check,
  note,
  onSelect,
  onRemove,
}: {
  path: string
  label: string
  active: boolean
  check?: DirectoryCheck
  /** Said instead of the disk's verdict, where the row means something more. */
  note?: string
  onSelect: () => void
  onRemove?: () => void
}) {
  const usable =
    !check || check.status === "ok" || check.status === "will_create"

  // The note explains what a row *means*, which is worth more than "will be
  // created" on the temporary folder - that one is always about to be created
  // and saying so every time is noise. It does not outrank an actual problem
  // though: a folder that will not take a file has to say so.
  const says = usable ? (note ?? check?.message) : check?.message

  return (
    <div
      className={cn(
        "flex items-center gap-2 border border-l bg-muted/20 p-3 transition-colors",
        active ? "border-l-primary bg-muted/40" : "border-l-border",
        !usable && "border-l-destructive"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
      >
        {active ? (
          <RiCheckboxCircleFill className="size-4 shrink-0 text-primary" />
        ) : (
          <RiCheckboxBlankCircleLine className="size-4 shrink-0 text-muted-foreground" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">
              {folderName(path)}
            </span>
            <Badge variant="ghost" className="shrink-0">
              {label}
            </Badge>
          </div>

          <div
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={path}
          >
            {path}
          </div>

          {/* Always here, so a row does not change height when the disk
              answers a moment later. */}
          <p
            className={cn(
              "min-h-4 text-[10px] leading-snug",
              usable && note
                ? "text-muted-foreground"
                : STATUS_TONE[check?.status ?? "ok"]
            )}
          >
            {says ?? "Checking…"}
          </p>
        </div>
      </button>

      <Button
        variant="ghost"
        size="icon"
        className="shrink-0"
        disabled={check?.status !== "ok"}
        title={check?.status === "ok" ? `Open ${path}` : "It is not there yet"}
        aria-label={`Open ${path}`}
        onClick={() => void openPath(path)}
      >
        <RiFolderOpenLine />
      </Button>

      {onRemove ? (
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          title="Remove from the list"
          aria-label={`Remove ${path} from the list`}
          onClick={onRemove}
        >
          <RiCloseLine />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Where finished downloads land, as a list rather than a single field.
 *
 * One folder is in use and the rest are kept on hand, so switching between a
 * working folder and a permanent one is a click instead of a re-typed path.
 * What the rest of the app reads is still `downloads.location`, a single
 * string - the list is what that string is chosen from, and nothing else had
 * to learn about it.
 *
 * The first row is the service's own folder and cannot be removed. That is
 * the honest version of the old rule that the first path in the list was
 * undeletable: there has to be somewhere for files to go when the list is
 * empty, and this is where they were already going.
 */
export function SaveLocations({
  config,
  updateConfig,
}: Pick<SettingsSectionComponentProps, "config" | "updateConfig">) {
  // The folder the service writes to before anything is moved, which is what
  // an empty setting resolves to. Read here rather than passed in so the rest
  // of the settings screen does not re-render with the job list.
  const { health } = useInfernoService()
  const fallback = health?.download_dir ?? null

  const [known, setKnown] = useState<KnownFolder[]>([])
  const [draft, setDraft] = useState("")

  useEffect(() => {
    // Documents, Videos, Music and so on are the *user's* folders, which a
    // browser cannot see and a server does not have. Asking would return
    // nothing, so the list simply stays empty and its menu is not offered.
    if (!capabilities.localFilesystem) {
      return
    }
    void knownFolders().then(setKnown)
  }, [])

  const folders = config.downloads.folders
  const active = config.downloads.location.trim()

  const paths = useMemo(
    () => [
      ...(fallback ? [fallback] : []),
      ...folders.map((entry) => entry.path),
    ],
    [fallback, folders]
  )
  const checks = useDirectoryChecks(paths)

  const labels = useMemo(
    () => new Map(known.map((folder) => [folder.id, folder.label])),
    [known]
  )

  const setFolders = (next: DownloadFolder[]) =>
    updateConfig((current) => ({
      ...current,
      downloads: { ...current.downloads, folders: next },
    }))

  const choose = (path: string) =>
    updateConfig((current) => ({
      ...current,
      downloads: { ...current.downloads, location: path },
    }))

  const add = (folder: DownloadFolder) => {
    const path = folder.path.trim()

    if (!path) {
      return
    }

    if (folders.some((entry) => entry.path === path)) {
      toast.error("That folder is already in the list.")
      return
    }

    setFolders([...folders, { ...folder, path }])
    setDraft("")
    toast.success(`Added ${folderName(path)}`)
  }

  const remove = (path: string) => {
    setFolders(folders.filter((entry) => entry.path !== path))

    // Removing the folder in use would otherwise leave nothing selected and
    // downloads still going there, which is the row's claim being false.
    if (active === path) {
      choose("")
    }
  }

  // Only the presets not already on the list: adding one twice does nothing,
  // so offering it twice is offering a control that cannot work.
  const offerable = known.filter(
    (folder) => !folders.some((entry) => entry.path === folder.path)
  )

  // A path typed elsewhere - the configure panel binds the same setting - is
  // shown rather than silently unselected, with the means to keep it.
  const unlisted =
    active && !folders.some((entry) => entry.path === active) ? active : null

  return (
    <div className="flex flex-col gap-2">
      {fallback ? (
        <FolderRow
          path={fallback}
          label="App default"
          active={!active}
          check={checks[fallback]}
          onSelect={() => choose("")}
        />
      ) : null}

      {unlisted ? (
        <div className="flex items-center gap-2 border border-l border-l-primary bg-muted/40 p-3">
          <RiCheckboxCircleFill className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Not in the list</div>
            <div
              className="truncate font-mono text-[10px] text-muted-foreground"
              title={unlisted}
            >
              {unlisted}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => add({ source: "custom", path: unlisted })}
          >
            Keep it
          </Button>
        </div>
      ) : null}

      {folders.map((folder) => (
        <FolderRow
          key={folder.path}
          path={folder.path}
          label={labels.get(folder.source) ?? "Custom"}
          active={active === folder.path}
          check={checks[folder.path]}
          note={
            folder.source === TEMPORARY
              ? "Somewhere to put a file you will not keep. Windows clears this folder in its own time."
              : undefined
          }
          onSelect={() => choose(folder.path)}
          onRemove={() => remove(folder.path)}
        />
      ))}

      {/* Two ways in, because they answer different questions: the menu is
          for "the usual place", the field for "this exact one". */}
      <div className="flex items-start gap-1 border border-dashed p-3">
        <FolderField
          value={draft}
          onValueChange={setDraft}
          placeholder="Add another folder"
          emptyHint="Type a path or choose a folder, then add it to the list."
          className="min-w-0 flex-1"
          action={
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={!draft.trim()}
              title="Add this folder to the list"
              aria-label="Add this folder to the list"
              onClick={() => add({ source: "custom", path: draft })}
            >
              <RiAddLine />
            </Button>
          }
        />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={offerable.length === 0}
              >
                <RiHardDrive2Line data-icon="inline-start" />
                Presets
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-64">
            {offerable.map((folder) => (
              <DropdownMenuItem
                key={folder.id}
                onClick={() => add({ source: folder.id, path: folder.path })}
              >
                {folder.id === TEMPORARY ? (
                  <RiTimeLine data-icon="inline-start" />
                ) : (
                  <RiFolderOpenLine data-icon="inline-start" />
                )}
                <span className="min-w-0 flex-1 truncate">{folder.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
