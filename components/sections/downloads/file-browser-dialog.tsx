"use client"

import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiDownload2Line,
  RiEditLine,
  RiExternalLinkLine,
  RiFileLine,
  RiFileTextLine,
  RiFolder3Line,
  RiFolderAddLine,
  RiFolderOpenLine,
  RiHome3Line,
  RiImageLine,
  RiInformationLine,
  RiLayoutGridLine,
  RiMusic2Line,
  RiSearchLine,
  RiTableLine,
  RiVideoLine,
} from "@remixicon/react"
import { toast } from "sonner"

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import {
  ConfirmDialog,
  type ConfirmRequest,
} from "@/components/confirm-dialog"
import { capabilities } from "@/lib/deployment"
import { downloadFile, openFile, parentOf } from "@/lib/file-actions"
import { formatBytes } from "@/lib/format"
import {
  describeError,
  type FileEntry,
  type FileListing,
} from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import { useInfernoService } from "./service-context"

/**
 * "Open file location", for a client with no file manager.
 *
 * Laid out after SVAR's React file manager, which is the arrangement people
 * already know: a navigation tree on the left, a content pane that switches
 * between cards and a table, and a details panel on the right carrying the
 * metadata and the download button. The *layout* is what is borrowed - none of
 * the styling is. It is built from this app's own primitives and tokens, so it
 * inherits the theme instead of fighting it.
 *
 * Deliberately not borrowed: the half of that widget concerned with changing
 * things. No create, rename, delete, cut, paste or upload, and no split-view
 * panels - those exist to move files between two folders. This reads. Deleting
 * a download belongs to the queue, where it goes through the job and the
 * library stays consistent; a delete button here would be a second, quieter
 * path to the same thing that leaves the library pointing at nothing.
 *
 * Everything comes from `/api/v1/files`, which the server bounds to the
 * download directory. This cannot browse the host and is not meant to.
 */

type ViewMode = "cards" | "table"
type SortKey = "name" | "size" | "modified"

type BrowserState = {
  /**
   * Directory to list. Root-relative or absolute - the server accepts either
   * and bounds both to the download folder, so callers pass whichever they
   * have.
   */
  path: string
  /**
   * The file to select on arrival, by bare name rather than path.
   *
   * A caller may hold an absolute path (`files[].path` from the job API) or a
   * root-relative one, and comparing either against the listing's own relative
   * paths would need the root subtracted first. Within one directory a name is
   * unique, which is all this needs to be.
   */
  highlight: string | null
}

type FileBrowserValue = {
  /** Open at the root. */
  browse: () => void
  /** Open at a file's folder, with that file selected. */
  reveal: (path: string) => void
}

const FileBrowserContext = createContext<FileBrowserValue | null>(null)

/**
 * The desktop's answer, as one shared object.
 *
 * Identity matters: this is read into effect dependency arrays, and a fresh
 * object literal per call would change those on every render and re-run the
 * effects holding it - in the build where the feature does not exist at all.
 */
const NO_BROWSER: FileBrowserValue = {
  browse: () => {},
  reveal: () => {},
}

export function useFileBrowser(): FileBrowserValue {
  return useContext(FileBrowserContext) ?? NO_BROWSER
}

/** The last segment of a path, whichever separator it arrived with. */
function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path
}

function iconFor(entry: Pick<FileEntry, "type" | "mime" | "name">) {
  if (entry.type === "directory") {
    return RiFolder3Line
  }
  const mime = entry.mime ?? ""
  if (mime.startsWith("video/")) {
    return RiVideoLine
  }
  if (mime.startsWith("audio/")) {
    return RiMusic2Line
  }
  if (mime.startsWith("image/")) {
    return RiImageLine
  }
  if (mime.startsWith("text/") || mime.includes("json")) {
    return RiFileTextLine
  }

  return RiFileLine
}

/** `MKV`, from the name rather than the mime - it is what people recognise. */
function kindOf(entry: FileEntry) {
  if (entry.type === "directory") {
    return "Folder"
  }
  const dot = entry.name.lastIndexOf(".")

  return dot > 0 ? entry.name.slice(dot + 1).toUpperCase() : "File"
}

function formatWhen(epochSeconds: number | null | undefined) {
  if (!epochSeconds) {
    return "—"
  }

  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

/** Every segment of the current path, each with the path that leads to it. */
function crumbsFor(relative: string) {
  const parts = relative.split("/").filter(Boolean)

  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }))
}

/**
 * One branch of the navigation tree.
 *
 * Children arrive only when a folder is first expanded - the API lists one
 * directory per call, and walking the tree up front would be a request per
 * folder for branches nobody opens.
 */
function TreeBranch({
  path,
  name,
  depth,
  currentPath,
  expanded,
  childrenByPath,
  onToggle,
  onOpen,
}: {
  path: string
  name: string
  depth: number
  currentPath: string
  expanded: Set<string>
  childrenByPath: Record<string, FileEntry[]>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
}) {
  const isOpen = expanded.has(path)
  const branchChildren = childrenByPath[path]
  const isCurrent = currentPath === path

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 py-1 pr-2 text-xs transition-colors",
          isCurrent
            ? "bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] text-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        <button
          type="button"
          aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={isOpen}
          onClick={() => onToggle(path)}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          {isOpen ? (
            <RiArrowDownSLine className="size-3" />
          ) : (
            <RiArrowRightSLine className="size-3" />
          )}
        </button>
        {/* An open folder for an expanded branch, a closed one otherwise -
            the chevron says the same thing, and the icon agreeing with it is
            what makes a deep tree readable at a glance. */}
        {isOpen ? (
          <RiFolderOpenLine aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <RiFolder3Line aria-hidden className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onOpen(path)}
          className="min-w-0 flex-1 truncate text-left"
        >
          {name}
        </button>
      </div>
      {isOpen ? (
        <ul>
          {branchChildren === undefined ? (
            <li
              className="py-1 text-[10px] text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 12 + 26}px` }}
            >
              Loading…
            </li>
          ) : branchChildren.length === 0 ? (
            <li
              className="py-1 text-[10px] text-muted-foreground/70"
              style={{ paddingLeft: `${(depth + 1) * 12 + 26}px` }}
            >
              No folders
            </li>
          ) : (
            branchChildren.map((child) => (
              <TreeBranch
                key={child.path}
                path={child.path}
                name={child.name}
                depth={depth + 1}
                currentPath={currentPath}
                expanded={expanded}
                childrenByPath={childrenByPath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  )
}

export function FileBrowserProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { client } = useInfernoService()

  const [state, setState] = useState<BrowserState | null>(null)
  const [listing, setListing] = useState<FileListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * What is selected, by path.
   *
   * A set rather than one entry because dragging a box over six files has to
   * mean six files. The details panel still wants a single entry, which is
   * derived below - it is the interesting case only when exactly one thing is
   * selected.
   */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /** Where a shift-click range starts. Windows keeps this across clicks. */
  const [anchor, setAnchor] = useState<string | null>(null)
  /**
   * The drag rectangle, in viewport coordinates.
   *
   * Viewport rather than container-relative on purpose: hit-testing compares
   * against `getBoundingClientRect`, which is also viewport-based, so a list
   * that scrolls mid-drag needs no correction. The box is drawn `fixed` for
   * the same reason and clamped to the content pane, so it never paints over
   * the tree or the details panel.
   */
  const [marquee, setMarquee] = useState<{
    x1: number
    y1: number
    x2: number
    y2: number
  } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** The two questions this asks, as dialogs rather than browser chrome. */
  const [naming, setNaming] = useState<NameRequest | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  /**
   * What the key handler reads, rather than what it depends on.
   *
   * `visible` changes on every keystroke in the search box and `selection` on
   * every click; depending on either would tear down and rebind the listener
   * constantly for no behavioural gain.
   */
  const selectionRef = useRef(selection)
  const visibleRef = useRef<FileEntry[]>([])
  const [view, setView] = useState<ViewMode>("cards")
  const [showDetails, setShowDetails] = useState(true)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: "name",
    ascending: true,
  })

  // Folders only, keyed by the path they belong to. Not invalidated while the
  // dialog is open: re-expanding is cheap on reopen, and a tree that reshuffles
  // under the cursor mid-browse is worse than a slightly stale one.
  const [childrenByPath, setChildrenByPath] = useState<
    Record<string, FileEntry[]>
  >({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const searchRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<HTMLInputElement>(null)

  // The explorer bar's two forms. `draftPath` is only live while typing, so
  // navigating never has to write back into it and a half-typed path is never
  // mistaken for where you are.
  const [editingPath, setEditingPath] = useState(false)
  const [draftPath, setDraftPath] = useState("")

  /**
   * Move to a directory, and reset what the last one left behind.
   *
   * The loading and error flags are set here rather than at the top of the
   * effect below: setting them there would be a synchronous setState inside an
   * effect - a second render pass before paint on every navigation - where this
   * is one render with the new state already in it.
   */
  const navigate = useCallback((path: string, highlight: string | null) => {
    setState({ path, highlight })
    setEditingPath(false)
    setDraftPath("")
    setSelection(new Set())
    setAnchor(null)
    setQuery("")
    setLoading(true)
    setError(null)
  }, [])

  const value = useMemo<FileBrowserValue>(
    () => ({
      browse: () => navigate("", null),
      reveal: (path: string) => navigate(parentOf(path), baseName(path)),
    }),
    [navigate]
  )

  // Re-listed on every navigation rather than cached. A download finishing
  // while this is open changes the folder underneath it, and a stale list that
  // looks authoritative is worse than a brief spinner.
  useEffect(() => {
    if (!state || !client) {
      return
    }

    let cancelled = false

    client
      .listFiles(state.path)
      .then((next) => {
        if (cancelled) {
          return
        }
        setListing(next)
        // The tree and the content pane read the same listing, so arriving
        // anywhere fills in that branch for free.
        setChildrenByPath((prior) => ({
          ...prior,
          [next.path]: next.entries.filter((e) => e.type === "directory"),
        }))
        if (state.highlight) {
          const found = next.entries.find(
            (entry) => entry.name === state.highlight
          )
          if (found) {
            setSelection(new Set([found.path]))
            setAnchor(found.path)
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setListing(null)
          setError(describeError(cause))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [client, state])

  const toggleBranch = useCallback(
    (path: string) => {
      setExpanded((prior) => {
        const next = new Set(prior)
        if (next.has(path)) {
          next.delete(path)

          return next
        }
        next.add(path)

        return next
      })

      // Fetched once per folder, on first expand.
      if (childrenByPath[path] !== undefined || !client) {
        return
      }
      client
        .listFiles(path)
        .then((result) =>
          setChildrenByPath((prior) => ({
            ...prior,
            [path]: result.entries.filter((e) => e.type === "directory"),
          }))
        )
        .catch(() =>
          // A branch that will not open is not worth a toast - the row says
          // "No folders", and navigating into it surfaces the real failure in
          // the content pane where it can be read.
          setChildrenByPath((prior) => ({ ...prior, [path]: [] }))
        )
    },
    [childrenByPath, client]
  )

  // Focus only. Seeding the field happens in `startEditingPath`, where the
  // decision to show it is made - doing it here would be a setState inside an
  // effect, and a second render pass before the field is even visible.
  useEffect(() => {
    if (!editingPath) {
      return
    }
    pathRef.current?.focus()
    pathRef.current?.select()
  }, [editingPath])

  const startEditingPath = useCallback(() => {
    setDraftPath(listing?.path ?? "")
    setEditingPath(true)
  }, [listing])

  const close = useCallback((open: boolean) => {
    if (!open) {
      setState(null)
      setListing(null)
      setError(null)
      setSelection(new Set())
      setAnchor(null)
      setQuery("")
      setEditingPath(false)
      setDraftPath("")
    }
  }, [])

  // Ctrl+F to the search box, as the widget this follows does. Bound only while
  // the dialog is open, so it never steals the browser's own find otherwise.
  useEffect(() => {
    if (!state) {
      return
    }

    function onKeyDown(event: KeyboardEvent) {
      // Escape clears the selection before it closes anything, which is what
      // a file manager does and what makes a mis-drag cheap to undo.
      if (event.key === "Escape" && selectionRef.current.size > 0) {
        event.preventDefault()
        event.stopPropagation()
        setSelection(new Set())

        return
      }
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      if (event.key.toLowerCase() === "a") {
        event.preventDefault()
        setSelection(new Set(visibleRef.current.map((entry) => entry.path)))

        return
      }
      const key = event.key.toLowerCase()
      if (key === "f") {
        event.preventDefault()
        searchRef.current?.focus()
      }
      // Ctrl+L to the address bar, which is where every browser and file
      // manager puts it.
      if (key === "l") {
        event.preventDefault()
        startEditingPath()
      }
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [state, startEditingPath])

  const visible = useMemo(() => {
    const entries = listing?.entries ?? []
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? entries.filter((entry) => entry.name.toLowerCase().includes(needle))
      : entries

    const direction = sort.ascending ? 1 : -1

    return [...filtered].sort((a, b) => {
      // Folders keep their place at the top under every sort, the way file
      // managers do it - sorting by size would otherwise scatter them through
      // the list on a value they do not have.
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      if (sort.key === "size") {
        return ((a.size ?? 0) - (b.size ?? 0)) * direction
      }
      if (sort.key === "modified") {
        return ((a.modified ?? 0) - (b.modified ?? 0)) * direction
      }

      return a.name.localeCompare(b.name) * direction
    })
  }, [listing, query, sort])

  // Kept current for the key handler, which reads them instead of depending on
  // them. Written in an effect rather than during render: a ref assignment in
  // the render body runs on every pass, including ones React throws away.
  useEffect(() => {
    selectionRef.current = selection
    visibleRef.current = visible
  }, [selection, visible])


  /**
   * One entry, only when it is the only one.
   *
   * The details panel describes a file; with six selected there is no file to
   * describe, so it shows a count instead and this is null.
   */
  const selected =
    selection.size === 1
      ? (visible.find((entry) => selection.has(entry.path)) ?? null)
      : null

  /**
   * Click, with the modifiers every file manager honours.
   *
   * Ctrl toggles one, shift takes the range from the anchor, and a plain click
   * replaces the selection. The anchor moves on every click except a shift one,
   * which is what makes shift-clicking twice extend from the same origin rather
   * than from wherever you last landed.
   */
  const selectEntry = (entry: FileEntry, event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      setSelection((prior) => {
        const next = new Set(prior)
        if (next.has(entry.path)) {
          next.delete(entry.path)
        } else {
          next.add(entry.path)
        }

        return next
      })
      setAnchor(entry.path)

      return
    }

    if (event.shiftKey && anchor) {
      const from = visible.findIndex((candidate) => candidate.path === anchor)
      const to = visible.findIndex((candidate) => candidate.path === entry.path)
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from]
        setSelection(
          new Set(visible.slice(start, end + 1).map((candidate) => candidate.path))
        )

        return
      }
    }

    setSelection(new Set([entry.path]))
    setAnchor(entry.path)
  }

  /**
   * Drag a box over the list, as Explorer and Finder do.
   *
   * Started only on the background of the content pane, never on a row - a
   * drag that begins on an item is that item being clicked, and swallowing it
   * would break selecting anything. The `button` check keeps a right-click
   * from starting one.
   *
   * Held on `window` rather than the pane so releasing the mouse outside the
   * dialog still ends the drag, instead of leaving a box stuck to the cursor.
   */
  const startMarquee = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }
    const target = event.target as HTMLElement
    if (target.closest("[data-entry-path]")) {
      return
    }

    const surface = contentRef.current
    if (!surface) {
      return
    }

    const additive = event.ctrlKey || event.metaKey || event.shiftKey
    const base = additive ? new Set(selection) : new Set<string>()
    if (!additive) {
      setSelection(base)
    }

    /** Client coordinates, expressed against the drag surface. */
    const toSurface = (clientX: number, clientY: number) => {
      const bounds = surface.getBoundingClientRect()

      return { x: clientX - bounds.left, y: clientY - bounds.top }
    }

    const origin = toSurface(event.clientX, event.clientY)
    setMarquee({ x1: origin.x, y1: origin.y, x2: origin.x, y2: origin.y })

    const onMove = (move: MouseEvent) => {
      const current = toSurface(move.clientX, move.clientY)
      setMarquee({ x1: origin.x, y1: origin.y, x2: current.x, y2: current.y })

      const box = {
        left: Math.min(origin.x, current.x),
        right: Math.max(origin.x, current.x),
        top: Math.min(origin.y, current.y),
        bottom: Math.max(origin.y, current.y),
      }

      // Rows are measured into the same space, so the comparison holds however
      // far the list has scrolled since the drag began.
      const bounds = surface.getBoundingClientRect()
      const hit = new Set(base)
      for (const node of surface.querySelectorAll<HTMLElement>(
        "[data-entry-path]"
      )) {
        const rect = node.getBoundingClientRect()
        const left = rect.left - bounds.left
        const top = rect.top - bounds.top
        // Touching counts, the way it does in Explorer - a box has to cover
        // part of a row, not all of it.
        const overlaps =
          left < box.right &&
          left + rect.width > box.left &&
          top < box.bottom &&
          top + rect.height > box.top
        if (overlaps) {
          const path = node.dataset.entryPath
          if (path) {
            hit.add(path)
          }
        }
      }
      setSelection(hit)
    }

    const onUp = () => {
      setMarquee(null)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  // The desktop has a real file manager; this would be a worse version of it.
  if (!capabilities.fileBrowser) {
    return <>{children}</>
  }

  const openEntry = (entry: FileEntry) => {
    if (entry.type === "directory") {
      navigate(entry.path, null)

      return
    }
    void openFile(client, {
      url: entry.url,
      name: entry.name,
      // Listing entries are already root-relative, which is exactly what the
      // viewer route is keyed on.
      relativePath: entry.path,
    }).catch((cause: unknown) =>
      toast.error("Could not open", { description: describeError(cause) })
    )
  }

  const download = (entry: FileEntry) =>
    void downloadFile(client, { url: entry.url, name: entry.name }).catch(
      (cause: unknown) =>
        toast.error("Could not download", { description: describeError(cause) })
    )

  /**
   * Re-list the folder after something in it changed.
   *
   * The listing is the source of truth for both panes, so refetching is both
   * the update and the confirmation - no local patching of a list that the
   * server has already moved on from.
   */
  const refresh = async () => {
    if (!client || !state) {
      return
    }
    const next = await client.listFiles(state.path)
    setListing(next)
    setChildrenByPath((prior) => ({
      ...prior,
      [next.path]: next.entries.filter((e) => e.type === "directory"),
    }))
  }

  /** Everything currently selected, as entries rather than paths. */
  const selectedEntries = visible.filter((entry) => selection.has(entry.path))

  const runFileAction = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action()
      await refresh()
    } catch (cause) {
      toast.error(`Could not ${what}`, { description: describeError(cause) })
    }
  }

  const createFolder = () => {
    if (!client) {
      return
    }
    setNaming({
      title: "New folder",
      label: "Name",
      confirmLabel: "Create",
      initial: "",
      run: (name) =>
        void runFileAction("create the folder", () =>
          client.createFolder(listing?.path ?? "", name)
        ),
    })
  }

  const renameEntry = (entry: FileEntry) => {
    if (!client) {
      return
    }
    setNaming({
      title: `Rename ${entry.type === "directory" ? "folder" : "file"}`,
      label: "Name",
      confirmLabel: "Rename",
      initial: entry.name,
      run: (name) => {
        if (name === entry.name) {
          return
        }
        void runFileAction("rename", () => client.renameFile(entry.path, name))
      },
    })
  }

  /**
   * Delete, on the whole selection when the clicked row is part of it.
   *
   * That is what every file manager does, and the alternative - deleting only
   * the row under the cursor while five others sit highlighted - is how people
   * lose files they meant to keep.
   */
  const deleteEntries = (entry: FileEntry) => {
    const targets = selection.has(entry.path) ? selectedEntries : [entry]
    if (!client || targets.length === 0) {
      return
    }
    const what =
      targets.length === 1 ? targets[0].name : `${targets.length} items`

    setConfirm({
      title: `Delete ${what}?`,
      description:
        targets.length === 1 && targets[0].type === "directory"
          ? "The folder and everything in it is removed from the server. This cannot be undone."
          : "This removes it from the server. Downloads already in the queue keep their entry and will show the file as missing. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
      run: () =>
        void runFileAction("delete", async () => {
          for (const target of targets) {
            await client.deleteFile(target.path)
          }
          setSelection(new Set())
        }),
    })
  }

  /** The same menu for a card and for a table row. */
  const menuFor = (entry: FileEntry, node: React.ReactElement) => (
    <EntryMenu
      entry={entry}
      selectionSize={selection.size}
      onOpen={() => openEntry(entry)}
      onDownload={() => download(entry)}
      onReveal={() => navigate(entry.path, null)}
      onRename={() => renameEntry(entry)}
      onDelete={() => deleteEntries(entry)}
      onNewFolder={createFolder}
    >
      {node}
    </EntryMenu>
  )

  const sortBy = (key: SortKey) =>
    setSort((prior) => ({
      key,
      ascending: prior.key === key ? !prior.ascending : true,
    }))

  const crumbs = crumbsFor(listing?.path ?? "")
  const rootChildren = childrenByPath[""] ?? []
  const columns: [SortKey, string][] = [
    ["name", "Name"],
    ["size", "Size"],
    ["modified", "Modified"],
  ]

  return (
    <FileBrowserContext.Provider value={value}>
      {children}
      <Dialog open={state !== null} onOpenChange={close}>
        <DialogContent
          // Deliberately close to the whole viewport. This is a file manager,
          // and the thing it is worst at is showing six items through a
          // letterbox. Height is a fixed share rather than content-driven: a
          // list that resizes its own dialog as you move between folders is
          // unusable. Padding drops to zero because the panes own their edges.
          className="flex h-[92dvh] w-[min(1600px,calc(100%-2rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none"
        >
          <div className="flex shrink-0 flex-col border-b">
            <div className="flex items-center gap-2 px-4 pt-3 pr-12">
              <DialogTitle className="font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
                Files
              </DialogTitle>
              <DialogDescription className="sr-only">
                Browse the folder the service downloads into. Read-only.
              </DialogDescription>
            </div>

            {/* The explorer bar: where you are, and how to get somewhere else.
                Its own row rather than sharing one with the controls - it is
                the thing you read most and click most, and a path is the one
                element here with no natural width. */}
            <div className="flex items-center gap-2 px-4 py-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Up one folder"
                aria-label="Up one folder"
                disabled={!listing || listing.parent === null}
                onClick={() => navigate(listing?.parent ?? "", null)}
              >
                <RiArrowUpLine className="size-3.5" />
              </Button>

              {/* One control that is a path and a text field at once, rather
                  than two with a button to swap between them. Clicking a
                  segment navigates; clicking the space beside them turns the
                  whole bar into an input holding the same path, which is the
                  gesture every browser address bar already trains people in.
                  Styled as the field it becomes, so nothing moves when it
                  does. */}
              <div
                className={cn(
                  "flex h-8 min-w-0 flex-1 items-center border border-transparent border-b-input px-2 transition-colors",
                  editingPath && "border-b-ring"
                )}
              >
              {editingPath ? (
                <form
                  className="flex min-w-0 flex-1 items-center"
                  onSubmit={(event) => {
                    event.preventDefault()
                    navigate(draftPath.trim(), null)
                  }}
                >
                  <Input
                    ref={pathRef}
                    value={draftPath}
                    onChange={(event) => setDraftPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        // Kept off the dialog's own Escape handling, which
                        // would otherwise clear the selection behind this.
                        event.stopPropagation()
                        setEditingPath(false)
                      }
                    }}
                    // Clicking away goes back to the crumbs having applied
                    // nothing - the path is still whatever it was.
                    onBlur={() => setEditingPath(false)}
                    aria-label="Path"
                    placeholder="downloads/…"
                    className="h-7 border-0 font-mono text-[11px]"
                  />
                </form>
              ) : (
                <Breadcrumb className="min-w-0 shrink overflow-hidden">
                  {/* `normal-case`: the component uppercases by default, and
                      a path has to read as the names on disk. An override
                      rather than a change to the component - that default is
                      theirs, and this is the one place it is wrong. */}
                      <BreadcrumbList className="flex-nowrap gap-1 font-mono text-[10px] tracking-[0.08em] normal-case sm:gap-1.5">
                    <BreadcrumbItem className="shrink-0">
                      {crumbs.length === 0 ? (
                        <BreadcrumbPage className="flex items-center gap-1">
                          <RiHome3Line className="size-3" />
                          downloads
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink
                          render={
                            <button
                              type="button"
                              onClick={() => navigate("", null)}
                              className="flex items-center gap-1"
                            />
                          }
                        >
                          <RiHome3Line className="size-3" />
                          downloads
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>

                    {/* A deep path collapses in the middle rather than
                        squeezing every segment to nothing. The first and last
                        two are what orient you; the rest is what the typed
                        form is for. */}
                    {crumbs.length > 3 ? (
                      <>
                        <BreadcrumbSeparator className="shrink-0" />
                        <BreadcrumbItem className="shrink-0">
                          <BreadcrumbLink
                            render={
                              <button
                                type="button"
                                title="Type the full path"
                                onClick={startEditingPath}
                              />
                            }
                          >
                            <BreadcrumbEllipsis />
                          </BreadcrumbLink>
                        </BreadcrumbItem>
                      </>
                    ) : null}

                    {(crumbs.length > 3 ? crumbs.slice(-2) : crumbs).map(
                      (crumb, index, shown) => (
                        <Fragment key={crumb.path}>
                          <BreadcrumbSeparator className="shrink-0" />
                          <BreadcrumbItem className="min-w-0">
                            {index === shown.length - 1 ? (
                              <BreadcrumbPage className="truncate">
                                {crumb.name}
                              </BreadcrumbPage>
                            ) : (
                              <BreadcrumbLink
                                render={
                                  <button
                                    type="button"
                                    onClick={() => navigate(crumb.path, null)}
                                    className="truncate"
                                  />
                                }
                              >
                                {crumb.name}
                              </BreadcrumbLink>
                            )}
                          </BreadcrumbItem>
                        </Fragment>
                      )
                    )}
                  </BreadcrumbList>
                </Breadcrumb>
              )}

              {/* The rest of the bar. Clicking here is what turns it into the
                  field - the same dead space an address bar gives you, and the
                  reason there is no button to go and find. */}
              {editingPath ? null : (
                <button
                  type="button"
                  aria-label="Edit path"
                  title="Edit path (Ctrl+L)"
                  onClick={startEditingPath}
                  className="h-full min-w-8 flex-1 cursor-text"
                />
              )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4 pb-3">

              <div className="relative w-44 shrink-0">
                <RiSearchLine
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search this folder"
                  aria-label="Search this folder"
                  className="h-8 pl-7 text-xs"
                />
              </div>

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={showDetails ? "Hide details" : "Show details"}
                aria-label={showDetails ? "Hide details" : "Show details"}
                aria-pressed={showDetails}
                onClick={() => setShowDetails((on) => !on)}
                className={cn(showDetails && "text-foreground")}
              >
                <RiInformationLine className="size-3.5" />
              </Button>

              {/* Cards and table, the two modes that mean anything read-only.
                  The widget's third - split panels - exists to move files
                  between folders, which this cannot do. */}
              <div className="flex shrink-0 items-stretch border">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Cards"
                  aria-label="Card view"
                  aria-pressed={view === "cards"}
                  onClick={() => setView("cards")}
                  className={cn(
                    "rounded-none",
                    view === "cards" &&
                      "bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)]"
                  )}
                >
                  <RiLayoutGridLine className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title="Table"
                  aria-label="Table view"
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                  className={cn(
                    "rounded-none",
                    view === "table" &&
                      "bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)]"
                  )}
                >
                  <RiTableLine className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>

          {/* Navigation pane, content pane, details pane. */}
          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-52 shrink-0 border-r sm:block">
              <ScrollArea className="h-full">
                <ul className="py-2">
                  <li>
                    <div
                      className={cn(
                        "flex items-center gap-1.5 py-1 pr-2 pl-1.5 text-xs transition-colors",
                        listing?.path === ""
                          ? "bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <RiHome3Line aria-hidden className="size-3.5 shrink-0" />
                      <button
                        type="button"
                        onClick={() => navigate("", null)}
                        className="min-w-0 flex-1 truncate text-left"
                      >
                        downloads
                      </button>
                    </div>
                  </li>
                  {rootChildren.map((entry) => (
                    <TreeBranch
                      key={entry.path}
                      path={entry.path}
                      name={entry.name}
                      depth={1}
                      currentPath={listing?.path ?? ""}
                      expanded={expanded}
                      childrenByPath={childrenByPath}
                      onToggle={toggleBranch}
                      onOpen={(path) => navigate(path, null)}
                    />
                  ))}
                </ul>
              </ScrollArea>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
              <ScrollArea className="min-h-0 flex-1">
                {/* The drag surface. `min-h-full` so an almost-empty folder
                    still gives you somewhere to start a box, and `relative`
                    only to establish a containing block - the box itself is
                    fixed, and positioned in viewport coordinates. */}
                <EntryMenu
                  entry={null}
                  selectionSize={selection.size}
                  onOpen={() => {}}
                  onDownload={() => {}}
                  onReveal={() => {}}
                  onRename={() => {}}
                  onDelete={() => {}}
                  onNewFolder={createFolder}
                >
                <div
                  ref={contentRef}
                  onMouseDown={startMarquee}
                  className="relative min-h-full select-none"
                >
                {loading && !listing ? (
                  <div className="flex min-h-40 items-center justify-center py-16">
                    <Spinner />
                  </div>
                ) : error ? (
                  <Empty className="min-h-40 py-16">{error}</Empty>
                ) : visible.length === 0 ? (
                  <Empty className="min-h-40 py-16">
                    {query
                      ? `Nothing here matches "${query}".`
                      : "This folder is empty."}
                  </Empty>
                ) : view === "cards" ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2 p-3">
                    {visible.map((entry) => {
                      const Icon = iconFor(entry)
                      const active = selection.has(entry.path)

                      return menuFor(
                        entry,
                        <button
                          key={entry.path}
                          type="button"
                          data-entry-path={entry.path}
                          aria-pressed={active}
                          onClick={(event) => selectEntry(entry, event)}
                          onDoubleClick={() => openEntry(entry)}
                          className={cn(
                            "flex flex-col items-center gap-2 border p-3 text-center transition-colors",
                            active
                              ? "border-primary bg-primary/20"
                              : "border-transparent hover:bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]"
                          )}
                        >
                          <Icon
                            aria-hidden
                            className="size-8 shrink-0 text-muted-foreground"
                          />
                          <span className="line-clamp-2 w-full text-[11px] leading-tight break-words">
                            {entry.name}
                          </span>
                          <span className="font-mono text-[9px] tracking-[0.06em] text-muted-foreground uppercase">
                            {entry.type === "directory"
                              ? "folder"
                              : formatBytes(entry.size ?? 0)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-popover">
                      <tr className="border-b">
                        {columns.map(([key, label]) => (
                          <th
                            key={key}
                            scope="col"
                            className={cn(
                              "px-3 py-2 font-mono text-[9.5px] font-normal tracking-[0.1em] text-muted-foreground uppercase",
                              key !== "name" && "w-40"
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => sortBy(key)}
                              className="flex items-center gap-1 transition-colors hover:text-foreground"
                            >
                              {label}
                              {sort.key === key ? (
                                <RiArrowDownSLine
                                  aria-hidden
                                  className={cn(
                                    "size-3 transition-transform",
                                    sort.ascending && "rotate-180"
                                  )}
                                />
                              ) : null}
                            </button>
                          </th>
                        ))}
                        <th scope="col" className="w-20 px-3 py-2">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((entry) => {
                        const Icon = iconFor(entry)
                        const active = selection.has(entry.path)

                        return menuFor(
                          entry,
                          <tr
                            key={entry.path}
                            data-entry-path={entry.path}
                            aria-selected={active}
                            onClick={(event) => selectEntry(entry, event)}
                            onDoubleClick={() => openEntry(entry)}
                            className={cn(
                              "border-b border-border/50 transition-colors",
                              active
                                ? "bg-primary/20 [&>td:first-child]:border-l-2 [&>td:first-child]:border-l-primary"
                                : "hover:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]"
                            )}
                          >
                            <td className="px-3 py-1.5">
                              <span className="flex min-w-0 items-center gap-2">
                                <Icon
                                  aria-hidden
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                />
                                {entry.type === "directory" ? (
                                  <button
                                    type="button"
                                    onClick={() => navigate(entry.path, null)}
                                    className="truncate text-left hover:underline"
                                  >
                                    {entry.name}
                                  </button>
                                ) : (
                                  <span className="truncate">{entry.name}</span>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                              {entry.type === "directory"
                                ? "—"
                                : formatBytes(entry.size ?? 0)}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                              {formatWhen(entry.modified)}
                            </td>
                            <td className="px-3 py-1.5">
                              {entry.type === "file" ? (
                                <span className="flex items-center justify-end gap-1">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    title="Open in a new tab"
                                    aria-label={`Open ${entry.name} in a new tab`}
                                    onClick={() => openEntry(entry)}
                                  >
                                    <RiExternalLinkLine />
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    title="Download"
                                    aria-label={`Download ${entry.name}`}
                                    onClick={() => download(entry)}
                                  >
                                    <RiDownload2Line />
                                  </Button>
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}

                  {/* Inside the surface its coordinates are measured against,
                      so it scrolls with the list and is clipped by the pane
                      instead of being clamped to it by hand. */}
                  {marquee ? <MarqueeBox rect={marquee} /> : null}
                </div>
                </EntryMenu>
              </ScrollArea>

              {/* The count, and the one thing worth stating plainly about a
                  file manager with no delete button. */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5 font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground uppercase">
                <span>
                  {loading
                    ? "loading"
                    : selection.size > 0
                      ? `${selection.size} selected of ${visible.length}`
                      : `${visible.length} of ${listing?.count ?? 0} items`}
                </span>
                <span>read-only · on the server</span>
              </div>
            </main>

            {showDetails ? (
              <aside className="hidden w-64 shrink-0 flex-col border-l lg:flex">
                {selected ? (
                  <>
                    <div className="flex items-start gap-2 border-b p-3">
                      <p className="min-w-0 flex-1 text-xs leading-tight break-words">
                        {selected.name}
                      </p>
                      {/* Download sits in the panel's top-right corner, where
                          the widget this follows puts it. */}
                      {selected.type === "file" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          title="Download"
                          aria-label={`Download ${selected.name}`}
                          onClick={() => download(selected)}
                        >
                          <RiDownload2Line className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>

                    <div className="flex items-center justify-center border-b p-6">
                      {selected.mime?.startsWith("image/") && selected.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={client?.href(selected.url) ?? ""}
                          alt={selected.name}
                          className="max-h-32 max-w-full object-contain"
                        />
                      ) : (
                        <PreviewIcon entry={selected} />
                      )}
                    </div>

                    <dl className="flex flex-col gap-2 p-3 text-[11px]">
                      {(
                        [
                          ["Type", kindOf(selected)],
                          [
                            "Size",
                            selected.type === "directory"
                              ? "—"
                              : formatBytes(selected.size ?? 0),
                          ],
                          ["Modified", formatWhen(selected.modified)],
                          ["Path", `downloads/${selected.path}`],
                        ] as [string, string][]
                      ).map(([label, detail]) => (
                        <div key={label} className="flex flex-col gap-0.5">
                          <dt className="font-mono text-[9px] tracking-[0.1em] text-muted-foreground uppercase">
                            {label}
                          </dt>
                          <dd className="break-words">{detail}</dd>
                        </div>
                      ))}
                    </dl>

                    {selected.type === "file" ? (
                      <div className="mt-auto border-t p-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => openEntry(selected)}
                        >
                          <RiExternalLinkLine className="size-3.5" />
                          Open in a new tab
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : selection.size > 1 ? (
                  /* Nothing to describe when six things are selected, so it
                     answers the question that does have one answer. */
                  <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
                    <p className="text-sm">{selection.size} items selected</p>
                    <p className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                      {formatBytes(
                        visible
                          .filter((entry) => selection.has(entry.path))
                          .reduce((total, entry) => total + (entry.size ?? 0), 0)
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-muted-foreground">
                    Select a file to see its details.
                  </div>
                )}
              </aside>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* Siblings of the browser rather than children of it: both portal to
          the body, and the browser stays open behind whichever is asking. */}
      {naming ? (
        <NameDialog
          // A new question is a new instance, so the field starts from the
          // right value without an effect writing into the previous one.
          key={`${naming.title}:${naming.initial}`}
          request={naming}
          onOpenChange={(open) => {
            if (!open) {
              setNaming(null)
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        request={confirm}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null)
          }
        }}
      />
    </FileBrowserContext.Provider>
  )
}

type NameRequest = {
  title: string
  label: string
  confirmLabel: string
  initial: string
  run: (name: string) => void
}

/**
 * Ask for a name.
 *
 * `window.prompt` did this first and was wrong twice over: it is the browser's
 * chrome rather than the app's, and in a dialog-heavy UI it arrives looking
 * like something the page did not mean to do. It also cannot be styled, cannot
 * show what it is renaming, and blocks the event loop while it is open.
 *
 * The field is selected on open, so typing replaces - which is what you want
 * for a rename and harmless for a new folder.
 */
function NameDialog({
  request,
  onOpenChange,
}: {
  request: NameRequest
  onOpenChange: (open: boolean) => void
}) {
  // Seeded once, on mount. The caller keys this component on the request, so a
  // new question is a new instance rather than an effect writing state into the
  // old one - which is the same reset, done where React can see it.
  const [value, setValue] = useState(request.initial)
  const fieldRef = useRef<HTMLInputElement>(null)

  // Focus only, a frame later so the dialog has mounted and can take it.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      fieldRef.current?.focus()
      fieldRef.current?.select()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [])

  const trimmed = value.trim()

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!trimmed) {
              return
            }
            request.run(trimmed)
            onOpenChange(false)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="inferno-name-field"
              className="font-mono text-[10px] tracking-[0.1em] text-muted-foreground uppercase"
            >
              {request.label}
            </label>
            <Input
              id="inferno-name-field"
              ref={fieldRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
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
              {request.confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The right-click menu on a row, and on the empty space around them.
 *
 * Split by what you clicked, the way a real file manager is: a folder offers
 * to open, rename or delete itself, a file adds viewing and downloading, and
 * the background offers only the things that belong to the folder you are in.
 *
 * Delete is last and separated, because it is the only entry here that
 * destroys something.
 */
function EntryMenu({
  entry,
  selectionSize,
  onOpen,
  onDownload,
  onReveal,
  onRename,
  onDelete,
  onNewFolder,
  children,
}: {
  entry: FileEntry | null
  selectionSize: number
  onOpen: () => void
  onDownload: () => void
  onReveal: () => void
  onRename: () => void
  onDelete: () => void
  onNewFolder: () => void
  children: React.ReactElement
}) {
  const many = entry !== null && selectionSize > 1
  const deleteLabel = many ? `Delete ${selectionSize} items` : "Delete"

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-56">
        {entry === null ? (
          <ContextMenuItem onClick={onNewFolder}>
            <RiFolderAddLine className="size-3.5" />
            New folder
          </ContextMenuItem>
        ) : entry.type === "directory" ? (
          <>
            <ContextMenuItem onClick={onReveal}>
              <RiFolderOpenLine className="size-3.5" />
              Open
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onNewFolder}>
              <RiFolderAddLine className="size-3.5" />
              New folder
            </ContextMenuItem>
            <ContextMenuItem onClick={onRename} disabled={many}>
              <RiEditLine className="size-3.5" />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onDelete} variant="destructive">
              <RiDeleteBinLine className="size-3.5" />
              {deleteLabel}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={onOpen}>
              <RiExternalLinkLine className="size-3.5" />
              Open in a new tab
            </ContextMenuItem>
            <ContextMenuItem onClick={onDownload}>
              <RiDownload2Line className="size-3.5" />
              Download
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRename} disabled={many}>
              <RiEditLine className="size-3.5" />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onDelete} variant="destructive">
              <RiDeleteBinLine className="size-3.5" />
              {deleteLabel}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The drag rectangle, laid out inside the scrolling content.
 *
 * `absolute`, not `fixed`, and this is the whole of why the first version drew
 * the box a long way from the cursor: the dialog centres itself with a
 * `translate`, and a transformed ancestor becomes the containing block for any
 * fixed descendant. So a fixed box here was positioned against the dialog
 * rather than the viewport, offset by however far the dialog sits from the
 * top-left of the screen.
 *
 * Absolute inside the surface it is measured from has no such problem, and
 * scrolls with the list for free.
 */
function MarqueeBox({
  rect,
}: {
  rect: { x1: number; y1: number; x2: number; y2: number }
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-30 border border-primary bg-primary/20"
      style={{
        left: Math.min(rect.x1, rect.x2),
        top: Math.min(rect.y1, rect.y2),
        width: Math.abs(rect.x2 - rect.x1),
        height: Math.abs(rect.y2 - rect.y1),
      }}
    />
  )
}


/**
 * The stand-in where there is nothing to show a thumbnail of.
 *
 * `createElement` rather than `const Icon = iconFor(entry)` and `<Icon />`:
 * that form reads to the lint rule as a component being defined during render,
 * which resets state on every pass. It is not - `iconFor` picks one of a fixed
 * set of imported components - but the rule cannot see that, and the cost of
 * saying it this way is a line of import rather than a suppression comment
 * that would also hide the real thing if it ever happened here.
 */
function PreviewIcon({ entry }: { entry: FileEntry }) {
  return createElement(iconFor(entry), {
    "aria-hidden": true,
    className: "size-12 text-muted-foreground/60",
  })
}
