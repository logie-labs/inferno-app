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
  RiDownload2Line,
  RiEditLine,
  RiExternalLinkLine,
  RiFileLine,
  RiFileTextLine,
  RiFolder3Fill,
  RiFolder3Line,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
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
        {isOpen ? (
          <RiFolder3Fill aria-hidden className="size-3.5 shrink-0" />
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

  const [selected, setSelected] = useState<FileEntry | null>(null)
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
    setSelected(null)
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
          setSelected(
            next.entries.find((entry) => entry.name === state.highlight) ?? null
          )
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
      setSelected(null)
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
      if (!event.ctrlKey && !event.metaKey) {
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

              {editingPath ? (
                /* The typed form of the same bar. Every file manager has one
                   behind Ctrl+L, because pasting a path beats clicking down to
                   it - and this one is the only way to reach a folder whose
                   name you know but whose parent is a long way up. */
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    navigate(draftPath.trim(), null)
                    setEditingPath(false)
                  }}
                >
                  <Input
                    ref={pathRef}
                    value={draftPath}
                    onChange={(event) => setDraftPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        setEditingPath(false)
                      }
                    }}
                    aria-label="Path"
                    placeholder="downloads/…"
                    className="h-8 font-mono text-[11px]"
                  />
                  <Button type="submit" variant="outline" size="sm">
                    Go
                  </Button>
                </form>
              ) : (
                <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
                  <BreadcrumbList className="flex-nowrap gap-1 font-mono text-[10px] tracking-[0.08em] sm:gap-1.5">
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
                                className="truncate"
                                render={
                                  <button
                                    type="button"
                                    onClick={() => navigate(crumb.path, null)}
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

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={editingPath ? "Show breadcrumbs" : "Type a path (Ctrl+L)"}
                aria-label={
                  editingPath ? "Show breadcrumbs" : "Type a path"
                }
                aria-pressed={editingPath}
                onClick={() =>
                  editingPath ? setEditingPath(false) : startEditingPath()
                }
                className={cn("shrink-0", editingPath && "text-foreground")}
              >
                <RiEditLine className="size-3.5" />
              </Button>
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
                      const active = selected?.path === entry.path

                      return (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => setSelected(entry)}
                          onDoubleClick={() => openEntry(entry)}
                          className={cn(
                            "flex flex-col items-center gap-2 border p-3 text-center transition-colors",
                            active
                              ? "border-foreground/30 bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)]"
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
                        const active = selected?.path === entry.path

                        return (
                          <tr
                            key={entry.path}
                            onClick={() => setSelected(entry)}
                            onDoubleClick={() => openEntry(entry)}
                            className={cn(
                              "border-b border-border/50 transition-colors",
                              active
                                ? "bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)]"
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
              </ScrollArea>

              {/* The count, and the one thing worth stating plainly about a
                  file manager with no delete button. */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5 font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground uppercase">
                <span>
                  {loading
                    ? "loading"
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
    </FileBrowserContext.Provider>
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
