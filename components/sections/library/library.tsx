"use client"

import { RiFolderLine } from "@remixicon/react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/**
 * The rail in the design carries a Library entry, but the canvas does not draw
 * the screen behind it. Placeholder so the rail is complete.
 */
export default function LibrarySection() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-baseline gap-3 px-6 pt-4 pb-3">
        <h1 className="text-xs font-semibold tracking-widest uppercase">
          Library
        </h1>
        <p className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
          finished downloads
        </p>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty className="max-w-md">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiFolderLine />
            </EmptyMedia>
            <EmptyTitle>Not designed yet</EmptyTitle>
            <EmptyDescription>
              The canvas defines the rail entry but not this screen.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  )
}
