"use client"

import { useMemo } from "react"

import {
  RiCloseLine,
  RiFolder3Line,
  RiImageLine,
  RiMusic2Line,
  RiSearchLine,
  RiVideoLine,
} from "@remixicon/react"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar, CalendarDayButton } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatCount } from "@/lib/format"
import type { LibraryFacets } from "@/lib/inferno-service"
import { cn } from "@/lib/utils"

/**
 * Everything you can narrow the library by, down the side of it.
 *
 * Filters rather than a search box alone because the question is usually not
 * "what was it called" - it is "the thing from last Tuesday", "the music", or
 * "whatever went into that folder". Each of those is a dimension the service
 * already knows, so each is a control rather than a query to compose.
 *
 * Every control carries its count, and those counts come from the service with
 * that control's own filter lifted - so a folder showing 3 has three things in
 * it when clicked, and the calendar keeps showing every day you could pick
 * rather than only the days inside the range already chosen.
 */

export type LibraryFilterState = {
  range: DateRange | undefined
  kind: string | null
  folder: string | null
  query: string
}

export const emptyFilters: LibraryFilterState = {
  range: undefined,
  kind: null,
  folder: null,
  query: "",
}

/** `2026-09-17`, in local time - which is the day a person means. */
export function dayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

const KIND_ICON: Record<string, typeof RiVideoLine> = {
  video: RiVideoLine,
  audio: RiMusic2Line,
  image: RiImageLine,
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

function FilterGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="px-1 font-mono text-[9.5px] tracking-[0.12em] text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </div>
  )
}

/** One filter row: a label, a count, and a pressed state. */
function FilterRow({
  label,
  count,
  active,
  icon: Icon,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  icon?: typeof RiVideoLine
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-2 border border-transparent px-2 py-1.5 text-left text-xs transition-colors",
        active
          ? "border-primary bg-primary/20 text-foreground"
          : "text-muted-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)] hover:text-foreground"
      )}
    >
      {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-70">
        {formatCount(count)}
      </span>
    </button>
  )
}

export function LibraryFilters({
  value,
  facets,
  onChange,
  className,
}: {
  value: LibraryFilterState
  facets: LibraryFacets | null
  onChange: (next: LibraryFilterState) => void
  className?: string
}) {
  // Memoised because the fallback is a fresh object each render, which would
  // make the month calculation below re-run every time regardless.
  const days = useMemo(() => facets?.days ?? {}, [facets])

  // The month the calendar opens on: the most recent day with anything in it,
  // so an empty current month does not hide a library full of last month.
  const busiestMonth = useMemo(() => {
    const keys = Object.keys(days).sort()
    const latest = keys[keys.length - 1]

    return latest ? new Date(`${latest}T12:00:00`) : undefined
  }, [days])

  const anyFilter =
    value.range?.from || value.kind || value.folder || value.query.trim()

  return (
    <aside
      className={cn(
        "flex w-64 shrink-0 flex-col border-r",
        className
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <RiSearchLine
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={value.query}
            onChange={(event) =>
              onChange({ ...value, query: event.target.value })
            }
            placeholder="Search the library"
            aria-label="Search the library"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {anyFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Clear every filter"
            aria-label="Clear every filter"
            onClick={() => onChange(emptyFilters)}
          >
            <RiCloseLine className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <FilterGroup title="When">
            <Calendar
              mode="range"
              selected={value.range}
              onSelect={(range) => onChange({ ...value, range })}
              defaultMonth={value.range?.from ?? busiestMonth}
              numberOfMonths={1}
              captionLayout="dropdown"
              className="w-full p-0 [--cell-size:--spacing(8)]"
              formatters={{
                formatMonthDropdown: (date) =>
                  date.toLocaleString("default", { month: "long" }),
              }}
              components={{
                // The day carries how many downloads landed on it, so the
                // calendar is a picture of the library rather than a date
                // picker that happens to sit next to one.
                DayButton: ({ children, modifiers, day, ...props }) => {
                  const count = days[dayKey(day.date)] ?? 0

                  return (
                    <CalendarDayButton
                      day={day}
                      modifiers={modifiers}
                      {...props}
                    >
                      {children}
                      {!modifiers.outside && count > 0 ? (
                        <span className="font-mono text-[8px] leading-none tabular-nums opacity-80">
                          {count}
                        </span>
                      ) : null}
                    </CalendarDayButton>
                  )
                },
              }}
            />
            {value.range?.from ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="self-start"
                onClick={() => onChange({ ...value, range: undefined })}
              >
                Any date
              </Button>
            ) : null}
          </FilterGroup>

          {facets && facets.kinds.length > 0 ? (
            <FilterGroup title="Kind">
              <div className="flex flex-col gap-0.5">
                {facets.kinds.map((entry) => (
                  <FilterRow
                    key={entry.kind}
                    label={entry.kind}
                    count={entry.count}
                    icon={KIND_ICON[entry.kind]}
                    active={value.kind === entry.kind}
                    // Clicking the one already chosen clears it, so a filter
                    // never needs a second control to undo it.
                    onClick={() =>
                      onChange({
                        ...value,
                        kind: value.kind === entry.kind ? null : entry.kind,
                      })
                    }
                  />
                ))}
              </div>
            </FilterGroup>
          ) : null}

          {facets && facets.folders.length > 0 ? (
            <FilterGroup title="Folder">
              <div className="flex flex-col gap-0.5">
                {facets.folders.map((entry) => (
                  <FilterRow
                    key={entry.path}
                    label={folderName(entry.path)}
                    count={entry.count}
                    icon={RiFolder3Line}
                    active={value.folder === entry.path}
                    onClick={() =>
                      onChange({
                        ...value,
                        folder:
                          value.folder === entry.path ? null : entry.path,
                      })
                    }
                  />
                ))}
              </div>
            </FilterGroup>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}
