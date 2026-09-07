"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { formatBytes } from "@/lib/format"
import type { VideoFormat } from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

import { RuleButton } from "./rule-button"

function OverlayShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-60 flex flex-col gap-4 bg-background p-4",
        "animate-in duration-150 fade-in-0",
        className
      )}
    >
      {children}
    </div>
  )
}

function OverlayHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
      {children}
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return <RuleButton onClick={onClose}>Close</RuleButton>
}

const videoColumns = "grid-cols-[52px_56px_1fr_46px_76px]"
const audioColumns = "grid-cols-[52px_56px_1fr_76px]"

function sizeOf(format: VideoFormat) {
  const bytes = format.filesize ?? format.filesize_approx

  return bytes ? formatBytes(bytes) : "—"
}

function videoSpec(format: VideoFormat) {
  return [format.resolution, format.vcodec].filter(Boolean).join(" ") || "—"
}

function audioSpec(format: VideoFormat) {
  const bitrate = format.abr ? `${Math.round(format.abr)}k` : null

  return [format.acodec, bitrate].filter(Boolean).join(" ") || "—"
}

/**
 * The raw yt-dlp format table, straight off `GET /api/v1/formats`.
 *
 * Picking a row sets `format_id` on the request - the escape hatch the service
 * honours in place of quality and container (SPEC §7). A merged `a+b` id is
 * rejected in audio mode, so the two tables stay separate here.
 */
export function RawFormatsOverlay({
  formats,
  selected,
  onSelect,
  onClose,
}: {
  formats: VideoFormat[]
  selected: string | null
  onSelect: (formatId: string) => void
  onClose: () => void
}) {
  const video = formats.filter(
    (format) => format.has_video ?? format.vcodec !== "none"
  )
  const audio = formats.filter(
    (format) =>
      (format.has_audio ?? format.acodec !== "none") &&
      !(format.has_video ?? format.vcodec !== "none")
  )

  return (
    <OverlayShell className="gap-3">
      <div className="flex shrink-0 items-baseline justify-between gap-4">
        <OverlayHeading>
          raw formats &mdash; pick one video or one audio stream
        </OverlayHeading>
        <div className="flex items-center gap-4">
          <div className="font-mono text-[10.5px] tracking-[0.06em]">
            {selected ?? `${formats.length} total`}
          </div>
          <CloseButton onClose={onClose} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className={cn(
              "grid shrink-0 gap-2 border-b px-3 pb-2 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase",
              videoColumns
            )}
          >
            <span>id</span>
            <span>ext</span>
            <span>video</span>
            <span>fps</span>
            <span className="text-right">size</span>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {video.map((format) => (
              <button
                key={format.format_id}
                type="button"
                onClick={() => onSelect(format.format_id)}
                className={cn(
                  "grid w-full gap-2 border-b px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-accent",
                  videoColumns,
                  format.format_id === selected
                    ? "bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] text-foreground"
                    : "text-muted-foreground"
                )}
              >
                <span>{format.format_id}</span>
                <span>{format.ext}</span>
                <span className="truncate">{videoSpec(format)}</span>
                <span>{format.fps ? Math.round(format.fps) : ""}</span>
                <span className="text-right">{sizeOf(format)}</span>
              </button>
            ))}
          </ScrollArea>
        </div>

        <div className="flex w-80 shrink-0 flex-col">
          <div
            className={cn(
              "grid shrink-0 gap-2 border-b px-3 pb-2 font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase",
              audioColumns
            )}
          >
            <span>id</span>
            <span>ext</span>
            <span>audio</span>
            <span className="text-right">size</span>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            {audio.map((format) => (
              <button
                key={format.format_id}
                type="button"
                onClick={() => onSelect(format.format_id)}
                className={cn(
                  "grid w-full gap-2 border-b px-3 py-2 text-left font-mono text-[11px] transition-colors hover:bg-accent",
                  audioColumns,
                  format.format_id === selected
                    ? "bg-[color-mix(in_oklab,var(--foreground)_9%,transparent)] text-foreground"
                    : "text-muted-foreground"
                )}
              >
                <span>{format.format_id}</span>
                <span>{format.ext}</span>
                <span className="truncate">{audioSpec(format)}</span>
                <span className="text-right">{sizeOf(format)}</span>
              </button>
            ))}
          </ScrollArea>
        </div>
      </div>
    </OverlayShell>
  )
}
