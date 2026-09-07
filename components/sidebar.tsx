"use client"

import {
  footerSections,
  primarySections,
  sectionIcons,
  sectionLabels,
  type SectionKey,
} from "@/components/sections/index"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface Props {
  active: SectionKey
  onChange: (key: SectionKey) => void
}

/**
 * Volcon's rail: a 14-wide column on `bg-muted/30`, where the active entry is
 * simply the one at full opacity. No accent bar, no filled background.
 */
function RailButton({
  id,
  active,
  onChange,
}: Props & {
  id: SectionKey
}) {
  const isActive = active === id
  const RailIcon = sectionIcons[id]

  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-current={isActive ? "page" : undefined}
            aria-label={sectionLabels[id]}
            onClick={() => onChange(id)}
            className={cn(
              "group relative flex size-14 items-center justify-center transition-all outline-none hover:opacity-70",
              isActive ? "opacity-100!" : "opacity-50"
            )}
          >
            <RailIcon className="size-5" />

            <div
              className={cn(
                "transistion-all pointer-events-none! absolute left-0 h-1 w-[2px] bg-foreground duration-200 ease-in-out",
                isActive ? "h-3 opacity-100!" : "opacity-0"
              )}
            />
          </button>
        }
      />
      <TooltipContent
        side="right"
        sideOffset={-10}
        className="pointer-events-none! capitalize select-none"
      >
        <p>{sectionLabels[id]}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function Sidebar({ active, onChange }: Props) {
  return (
    <TooltipProvider>
      <nav
        aria-label="Sections"
        className="inferno-vt-sidebar flex w-14 shrink-0 flex-col items-center justify-between border-r bg-muted/30 select-none"
      >
        <div className="flex flex-col">
          {primarySections.map((id) => (
            <RailButton key={id} id={id} active={active} onChange={onChange} />
          ))}
        </div>

        <div className="flex flex-col">
          {footerSections.map((id) => (
            <RailButton key={id} id={id} active={active} onChange={onChange} />
          ))}
        </div>
      </nav>
    </TooltipProvider>
  )
}
