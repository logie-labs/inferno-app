"use client"

import { useEffect, useMemo, useState } from "react"

import {
  RiAlertLine,
  RiArchiveLine,
  RiDownload2Line,
  RiExternalLinkLine,
  RiFileLine,
  RiFolderOpenLine,
  RiImageLine,
  RiLinkM,
  RiMusic2Line,
  RiVideoLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { useFileBrowser } from "@/components/sections/downloads/file-browser-dialog"
import { useInfernoService } from "@/components/sections/downloads/service-context"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { capabilities } from "@/lib/deployment"
import { downloadFile, openFile } from "@/lib/file-actions"
import { formatBytes, formatDuration } from "@/lib/format"
import {
  describeError,
  openUrl,
  type LibraryFacets,
  type LibraryItem,
} from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import {
  dayKey,
  emptyFilters,
  LibraryFilters,
  type LibraryFilterState,
} from "./library-filters"

/**
 * Everything that has ever finished, as opposed to what is happening now.
 *
 * The queue and this were the same list for as long as nothing was kept: a
 * download appeared in the queue, and when the app restarted it was gone. They
 * answer different questions, though, and now do. The queue is this session -
 * what you started, how far it got, what went wrong. The library is the record
 * - what exists, where it went, and when.
 *
 * Both are served by the same job history, which is why there is no second
 * store to keep in step. The queue reads the jobs it started; this reads all of
 * them, and the service does the filtering because it is the side that has
 * every row.
 */

/** How long typing settles before the library is re-queried. */
const SETTLE = 200

const KIND_ICON: Record<string, typeof RiVideoLine> = {
  video: RiVideoLine,
  audio: RiMusic2Line,
  image: RiImageLine,
  other: RiFileLine,
}

function whenText(seconds: number | null | undefined) {
  if (!seconds) {
    return "—"
  }
  const when = new Date(seconds * 1000)
  const today = new Date()
  const sameDay = dayKey(when) === dayKey(today)

  return sameDay
    ? when.toLocaleTimeString(undefined, { timeStyle: "short" })
    : when.toLocaleDateString(undefined, { dateStyle: "medium" })
}

/** One entry. Laid out as the queue's rows are, so the two read as one app. */
function LibraryRow({
  item,
  onOpen,
  onDownload,
  onReveal,
}: {
  item: LibraryItem
  onOpen: () => void
  onDownload: () => void
  onReveal: () => void
}) {
  const Icon = KIND_ICON[item.kind] ?? RiFileLine
  // Undefined means a service too old to report it; only an explicit false is
  // a file known to be gone.
  const missing = item.exists === false

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/50 px-4 py-2 transition-colors",
        "hover:bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          missing ? "text-destructive" : "text-muted-foreground"
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm" title={item.title ?? item.name}>
            {item.title ?? item.name}
          </span>
          {missing ? (
            <span className="shrink-0 font-mono text-[9px] tracking-[0.08em] text-destructive uppercase">
              missing
            </span>
          ) : null}
        </div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {[
            item.uploader,
            item.duration ? formatDuration(item.duration) : null,
            item.size ? formatBytes(item.size) : null,
            whenText(item.finished_at),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>

      <span className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Open"
          aria-label={`Open ${item.name}`}
          disabled={missing}
          onClick={onOpen}
        >
          <RiExternalLinkLine className="size-3.5" />
        </Button>
        {capabilities.downloadToBrowser ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Download"
            aria-label={`Download ${item.name}`}
            disabled={missing}
            onClick={onDownload}
          >
            <RiDownload2Line className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Show where it is"
          aria-label={`Show where ${item.name} is`}
          onClick={onReveal}
        >
          <RiFolderOpenLine className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Open the page it came from"
          aria-label="Open the page it came from"
          onClick={() => void openUrl(item.url).catch(() => {})}
        >
          <RiLinkM className="size-3.5" />
        </Button>
      </span>
    </div>
  )
}

export default function LibrarySection() {
  const { client, filesChanged } = useInfernoService()
  const fileBrowser = useFileBrowser()

  const [filters, setFilters] = useState<LibraryFilterState>(emptyFilters)
  const [page, setPage] = useState<{
    entries: LibraryItem[]
    total: number
    facets: LibraryFacets
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The whole query as one string, so an effect keyed on it re-runs when any
  // part of it changes and not when the objects around it are rebuilt.
  const query = useMemo(() => {
    const from = filters.range?.from
    const to = filters.range?.to ?? filters.range?.from

    return {
      // Whole days, local: a range of "the 14th" has to include everything
      // that happened on the 14th, not everything after midnight exactly.
      since: from ? new Date(from).setHours(0, 0, 0, 0) / 1000 : null,
      until: to ? new Date(to).setHours(23, 59, 59, 999) / 1000 : null,
      folder: filters.folder,
      kind: filters.kind,
      q: filters.query.trim() || null,
      limit: 500,
    }
  }, [filters])

  const key = JSON.stringify(query)
  // Re-read when the folder changes underneath, which is the same event the
  // file browser listens to - a download finishing, or a file deleted.
  const changed = filesChanged?.at ?? 0

  useEffect(() => {
    if (!client) {
      return
    }

    let live = true
    // Only the text field is debounced; clicking a filter should feel
    // immediate, and it cannot be typed at.
    const wait = JSON.parse(key).q ? SETTLE : 0
    const timer = setTimeout(() => {
      client
        .library(JSON.parse(key))
        .then((next) => {
          if (live) {
            setPage(next)
            setError(null)
          }
        })
        .catch((cause: unknown) => {
          if (live) {
            setError(describeError(cause))
          }
        })
        .finally(() => {
          if (live) {
            setLoading(false)
          }
        })
    }, wait)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, key, changed])

  const entries = page?.entries ?? []
  const filtered =
    filters.range?.from || filters.kind || filters.folder || filters.query.trim()

  return (
    <div className="flex h-full min-h-0">
      <LibraryFilters
        value={filters}
        facets={page?.facets ?? null}
        onChange={setFilters}
        className="hidden md:flex"
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-baseline gap-3 border-b px-4 py-3">
          <h1 className="font-mono text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
            Library
          </h1>
          <p className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            {loading && !page
              ? "reading"
              : filtered
                ? `${entries.length} of ${page?.total ?? 0} shown`
                : `${page?.total ?? 0} downloads`}
          </p>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          {loading && !page ? (
            <div className="flex min-h-40 items-center justify-center py-16">
              <Spinner />
            </div>
          ) : error ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiAlertLine />
                </EmptyMedia>
                <EmptyTitle>Could not read the library</EmptyTitle>
                <EmptyDescription>{error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : entries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiArchiveLine />
                </EmptyMedia>
                <EmptyTitle>
                  {filtered ? "Nothing matches" : "Nothing here yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {filtered
                    ? "No download matches these filters. Clearing one of them is usually the quickest way back."
                    : "Downloads land here as they finish, and stay - the queue only shows this session."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col">
              {entries.map((item) => (
                <LibraryRow
                  key={`${item.job_id}:${item.path}`}
                  item={item}
                  onOpen={() =>
                    void openFile(client, {
                      path: item.path,
                      name: item.name,
                      relativePath: item.folder_relative
                        ? `${item.folder_relative}/${item.name}`
                        : item.name,
                    }).catch((cause: unknown) =>
                      toast.error("Could not open", {
                        description: describeError(cause),
                      })
                    )
                  }
                  onDownload={() =>
                    void downloadFile(client, {
                      name: item.name,
                      relativePath: item.folder_relative
                        ? `${item.folder_relative}/${item.name}`
                        : item.name,
                    }).catch((cause: unknown) =>
                      toast.error("Could not download", {
                        description: describeError(cause),
                      })
                    )
                  }
                  onReveal={() => fileBrowser.revealLocation(item.path)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}
