"use client"

import { sections, type SectionKey } from "./index"

interface Props {
  active: SectionKey
}

export function SectionShell({ active }: Props) {
  const Active = sections[active] ?? sections.downloads

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden">
      {/* Keyed so switching sections remounts and replays the enter animation. */}
      <div
        key={active}
        className="absolute inset-0 animate-in duration-200 fade-in-0 slide-in-from-bottom-1"
      >
        <Active />
      </div>
    </div>
  )
}
