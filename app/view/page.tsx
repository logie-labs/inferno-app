"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { usePathname } from "next/navigation"

import {
  RiAlertLine,
  RiArrowLeftLine,
  RiDownload2Line,
  RiExternalLinkLine,
} from "@remixicon/react"

import { useInfernoService } from "@/components/sections/downloads/service-context"
import { Button } from "@/components/ui/button"
import { Empty } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { downloadFile } from "@/lib/file-actions"
import { formatBytes } from "@/lib/format"
import { describeError, type FileEntry } from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

/**
 * A page that plays one finished file, at `/view/<path>`.
 *
 * Opening the API's file URL straight into a tab does not work for media. The
 * response is a download, or at best a bare `<video>` element with no chrome,
 * and for a container the browser cannot demux - Matroska, most of the time -
 * it is a blank frame with no explanation. yt-dlp merges to `.mkv` by default,
 * so that is the common case, not the edge one.
 *
 * So the bytes still come from `/api/v1/files/content`, and this page wraps
 * them in something that can say what it is doing: a real player for what the
 * browser supports, and a plain, specific explanation plus a download for what
 * it does not.
 *
 * The route is served by the service for any `/view/...` path (see
 * `_install_web_root`), because a static export cannot pre-render a page per
 * file. The path after `/view/` is read here from the URL.
 */

type Playable = "video" | "audio" | "image" | "text" | "pdf" | "unknown"

/** What to try, from the extension. The mime from the API refines it later. */
function kindFrom(name: string, mime?: string | null): Playable {
  const type = mime ?? ""
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type.startsWith("image/")) return "image"
  if (type === "application/pdf") return "pdf"
  if (type.startsWith("text/") || type.includes("json")) return "text"

  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  if (["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"].includes(ext)) {
    return "video"
  }
  if (["mp3", "m4a", "opus", "ogg", "flac", "wav", "aac"].includes(ext)) {
    return "audio"
  }
  if (["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"].includes(ext)) {
    return "image"
  }
  if (ext === "pdf") return "pdf"
  if (["txt", "log", "json", "srt", "vtt", "md"].includes(ext)) return "text"

  return "unknown"
}

/**
 * Ask the browser whether it stands a chance, before showing it a black box.
 *
 * `canPlayType` answers "", "maybe" or "probably". Empty is a definite no and
 * is worth acting on: Matroska is the usual one, and yt-dlp produces it by
 * default, so this fires often. "maybe" is not a promise - the codecs inside a
 * container it recognises can still be unsupported - which is why the element's
 * own `error` event is handled as well rather than trusted to this.
 */
function probablyUnsupported(kind: Playable, name: string) {
  if (typeof document === "undefined") {
    return false
  }
  if (kind !== "video" && kind !== "audio") {
    return false
  }

  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  const guesses: Record<string, string> = {
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    flac: "audio/flac",
    wav: "audio/wav",
  }
  const candidate = guesses[ext]
  if (!candidate) {
    return false
  }

  const element = document.createElement(kind)

  return element.canPlayType(candidate) === ""
}

export default function ViewPage() {
  const pathname = usePathname()
  const { client } = useInfernoService()

  const [entry, setEntry] = useState<FileEntry | null>(null)
  const [lookupFailed, setLookupFailed] = useState<string | null>(null)
  const [playbackFailed, setPlaybackFailed] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)

  /**
   * The file this page is for, taken from the URL after `/view/`.
   *
   * Read from `usePathname` rather than a route param: the export produces one
   * `/view` page and the service serves it for every path beneath, so there is
   * no param to read. Decoded once here - the segment is percent-encoded, and
   * the API wants the real path.
   */
  const target = useMemo(() => {
    const raw = (pathname ?? "").replace(/^\/view\/?/, "")
    if (!raw) {
      return ""
    }
    try {
      return decodeURIComponent(raw)
    } catch {
      // A malformed escape is not worth failing over - the lookup below will
      // report it as missing, which is the same outcome and a better message.
      return raw
    }
  }, [pathname])

  const name = target.split("/").pop() ?? target
  const parent = target.includes("/")
    ? target.slice(0, target.lastIndexOf("/"))
    : ""

  // Metadata comes from listing the containing folder rather than a stat
  // endpoint, because that endpoint is the one the API has. It is only for
  // display - size, type, the accurate mime - so a failure here degrades to
  // playing the file with a guessed type rather than blocking on it.
  useEffect(() => {
    if (!client || !target) {
      return
    }

    let cancelled = false
    client
      .listFiles(parent)
      .then((listing) => {
        if (cancelled) {
          return
        }
        const found = listing.entries.find(
          (candidate) => candidate.name === name && candidate.type === "file"
        )
        if (found) {
          setEntry(found)
        } else {
          setLookupFailed("That file is not in the download folder any more.")
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLookupFailed(describeError(cause))
        }
      })

    return () => {
      cancelled = true
    }
  }, [client, name, parent, target])

  const kind = kindFrom(name, entry?.mime)
  const source = client
    ? client.href(`/api/v1/files/content?path=${encodeURIComponent(target)}`)
    : ""

  // Text is fetched rather than framed: an iframe of a text/plain response
  // inherits none of the page's typography and cannot be scrolled with it.
  useEffect(() => {
    if (kind !== "text" || !source) {
      return
    }

    let cancelled = false
    fetch(source)
      .then((response) => response.text())
      .then((body) => {
        if (!cancelled) {
          // Enough to read a subtitle track or a log without hanging the tab
          // on something that turned out to be enormous.
          setText(body.slice(0, 200_000))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlaybackFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [kind, source])

  const unsupported = playbackFailed || probablyUnsupported(kind, name)

  if (!target) {
    return (
      <Empty className="min-h-[60dvh]">
        No file was named in the address.
      </Empty>
    )
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col gap-4 p-4">
      {/* Header: what this is, and the two things to do with it. */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Back"
          aria-label="Back"
          onClick={() => window.history.back()}
        >
          <RiArrowLeftLine className="size-3.5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm" title={name}>
            {name}
          </p>
          <p className="truncate font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            downloads/{target}
            {entry?.size ? ` · ${formatBytes(entry.size)}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void downloadFile(client, {
              url: `/api/v1/files/content?path=${encodeURIComponent(target)}`,
              name,
            })
          }
        >
          <RiDownload2Line className="size-3.5" />
          Download
        </Button>
      </div>

      {lookupFailed ? (
        <Empty className="min-h-[50dvh]">{lookupFailed}</Empty>
      ) : unsupported ? (
        /* The honest case, and the common one: yt-dlp merges to Matroska by
           default and no browser demuxes it. Saying which part is the problem
           beats a black rectangle. */
        <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 border p-8 text-center">
          <RiAlertLine aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-sm">This browser cannot play this file.</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {name.toLowerCase().endsWith(".mkv")
              ? "Matroska (.mkv) is a container no browser supports, whatever the video inside it is. The file itself is fine - download it and open it in a player, or set the container to MP4 in Settings before downloading."
              : "The file is intact; its format is one this browser has no decoder for. Download it and open it in a player."}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                void downloadFile(client, {
                  url: `/api/v1/files/content?path=${encodeURIComponent(target)}`,
                  name,
                })
              }
            >
              <RiDownload2Line className="size-3.5" />
              Download
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.open(source, "_blank", "noopener")}
            >
              <RiExternalLinkLine className="size-3.5" />
              Open the raw file
            </Button>
          </div>
        </div>
      ) : kind === "video" ? (
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={source}
          controls
          autoPlay
          onError={() => setPlaybackFailed(true)}
          className="max-h-[70dvh] w-full bg-black"
        />
      ) : kind === "audio" ? (
        <div className="flex min-h-[30dvh] items-center justify-center border p-8">
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={source}
            controls
            autoPlay
            onError={() => setPlaybackFailed(true)}
            className="w-full max-w-lg"
          />
        </div>
      ) : kind === "image" ? (
        <div className="flex items-center justify-center border p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={source}
            alt={name}
            onError={() => setPlaybackFailed(true)}
            className="max-h-[70dvh] max-w-full object-contain"
          />
        </div>
      ) : kind === "pdf" ? (
        <iframe
          src={source}
          title={name}
          className="h-[70dvh] w-full border"
        />
      ) : kind === "text" ? (
        text === null ? (
          <div className="flex min-h-[30dvh] items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <pre
            className={cn(
              "max-h-[70dvh] overflow-auto border p-4",
              "font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
            )}
          >
            {text}
          </pre>
        )
      ) : (
        <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 border p-8 text-center">
          <p className="text-sm">There is no viewer for this kind of file.</p>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              void downloadFile(client, {
                url: `/api/v1/files/content?path=${encodeURIComponent(target)}`,
                name,
              })
            }
          >
            <RiDownload2Line className="size-3.5" />
            Download
          </Button>
        </div>
      )}
    </div>
  )
}
