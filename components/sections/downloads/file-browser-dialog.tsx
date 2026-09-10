"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"

import {
  RiArrowLeftLine,
  RiDownload2Line,
  RiExternalLinkLine,
  RiFolder3Line,
  RiFolderOpenLine,
  RiMusic2Line,
  RiVideoLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { capabilities } from "@/lib/deployment"
import { downloadFile, openFile, parentOf } from "@/lib/file-actions"
import { formatBytes } from "@/lib/format"
import { describeError, type FileListing } from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import { useInfernoService } from "./service-context"

/**
 * "Open file location", for a client with no file manager.
 *
 * The desktop hands a path to Explorer or Finder, which opens the folder and
 * highlights the file. There is no browser equivalent, so this is the nearest
 * honest one: the folder the file is in, listed, with that file picked out.
 *
 * It reads `/api/v1/files`, which is bounded to the download directory by the
 * server - this cannot browse the host, and is not meant to. It is a view of
 * what the service produced, not a filesystem manager: there is no rename, no
 * delete, no upload. Deleting a download is the queue's job, and it has to go
 * through the job for the library to stay consistent.
 */

type BrowserState = {
  /**
   * Directory to list. Root-relative or absolute - the server accepts either
   * and bounds both to the download folder, so callers pass whichever they
   * happen to have.
   */
  path: string
  /**
   * The file to mark, by bare name rather than path.
   *
   * A caller may hold an absolute path (`files[].path` from the job API) or a
   * root-relative one, and comparing either against the listing's own relative
   * paths would need the root subtracted first. Within one directory the name
   * is unique, which is all this needs to be.
   */
  highlight: string | null
}

/** The last segment of a path, whichever separator it arrived with. */
function baseName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path
}

type FileBrowserValue = {
  /** Open at the root. */
  browse: () => void
  /** Open at a file's folder, with that file highlighted. */
  reveal: (relativePath: string) => void
}

const FileBrowserContext = createContext<FileBrowserValue | null>(null)

/**
 * The desktop's answer, as one shared object.
 *
 * Identity matters: this is read into effect dependency arrays, and returning a
 * fresh object literal per call would change those on every render and re-run
 * the effects that hold it - in the build where the feature does not even
 * exist.
 */
const NO_BROWSER: FileBrowserValue = {
  browse: () => {},
  reveal: () => {},
}

/**
 * Always returns a value, even where the browser does not exist.
 *
 * On the desktop the provider renders nothing and these are no-ops, so a call
 * site can hold the handle unconditionally and gate only the menu entry that
 * uses it. Throwing when absent would push a `capabilities` check into every
 * consumer for no benefit.
 */
export function useFileBrowser(): FileBrowserValue {
  return useContext(FileBrowserContext) ?? NO_BROWSER
}

function iconFor(entry: { type: string; mime?: string | null; name: string }) {
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

  return RiVideoLine
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
   * Move to a directory, and reset what the last one left behind.
   *
   * The loading and error flags are set here rather than at the top of the
   * effect below. Setting them there would be a synchronous setState inside an
   * effect - a second render pass before paint, every navigation - where this
   * is one render with the new state already in it.
   */
  const navigate = useCallback((path: string, highlight: string | null) => {
    setState({ path, highlight })
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
        if (!cancelled) {
          setListing(next)
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

  const close = useCallback((open: boolean) => {
    if (!open) {
      setState(null)
      setListing(null)
      setError(null)
    }
  }, [])

  // The desktop has a real file manager; this would be a worse version of it.
  if (!capabilities.fileBrowser) {
    return <>{children}</>
  }

  const entries = listing?.entries ?? []

  return (
    <FileBrowserContext.Provider value={value}>
      {children}
      <Dialog open={state !== null} onOpenChange={close}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RiFolderOpenLine aria-hidden className="size-4 shrink-0" />
              {listing?.name ?? "Downloads"}
            </DialogTitle>
            <DialogDescription>
              {/* The full path, so it is clear this is the server's folder and
                  not anything on the machine the browser is running on. */}
              {listing?.path ? `downloads/${listing.path}` : "downloads"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 border-b pb-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!listing || listing.parent === null}
              onClick={() => navigate(listing?.parent ?? "", null)}
            >
              <RiArrowLeftLine aria-hidden className="size-3.5" />
              Up
            </Button>
            <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
              {loading ? "loading" : `${entries.length} items`}
            </span>
          </div>

          <ScrollArea className="h-80">
            {loading && !listing ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner />
              </div>
            ) : error ? (
              <Empty className="h-40">{error}</Empty>
            ) : entries.length === 0 ? (
              <Empty className="h-40">This folder is empty.</Empty>
            ) : (
              <ul className="divide-y">
                {entries.map((entry) => {
                  const Icon = iconFor(entry)
                  const highlighted = entry.name === state?.highlight

                  return (
                    <li
                      key={entry.path}
                      // `ref` on the highlighted row would let it scroll into
                      // view; the list is short enough that marking it is
                      // enough, and a scroll on open is easy to miss anyway.
                      className={cn(
                        "flex items-center gap-3 px-2 py-2",
                        highlighted && "bg-accent/60"
                      )}
                    >
                      <Icon
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      {entry.type === "directory" ? (
                        <button
                          type="button"
                          onClick={() => navigate(entry.path, null)}
                          className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                        >
                          {entry.name}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {entry.name}
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {entry.type === "directory"
                          ? "folder"
                          : formatBytes(entry.size ?? 0)}
                      </span>
                      {entry.type === "file" ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            title="Open in a new tab"
                            aria-label={`Open ${entry.name} in a new tab`}
                            onClick={() =>
                              void openFile(client, {
                                url: entry.url,
                                name: entry.name,
                              }).catch((cause: unknown) =>
                                toast.error("Could not open", {
                                  description: describeError(cause),
                                })
                              )
                            }
                          >
                            <RiExternalLinkLine className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            title="Download"
                            aria-label={`Download ${entry.name}`}
                            onClick={() =>
                              void downloadFile(client, {
                                url: entry.url,
                                name: entry.name,
                              }).catch((cause: unknown) =>
                                toast.error("Could not download", {
                                  description: describeError(cause),
                                })
                              )
                            }
                          >
                            <RiDownload2Line className="size-3.5" />
                          </Button>
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </FileBrowserContext.Provider>
  )
}
