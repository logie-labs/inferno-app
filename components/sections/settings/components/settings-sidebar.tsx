"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

import type { SettingsNavGroup, SettingsSectionId } from "../settings-registry"
import { SearchForm } from "./sidebar-search"

type SettingsSidebarProps = React.ComponentProps<"aside"> & {
  activeId: SettingsSectionId
  query: string
  onQueryChange: (value: string) => void
  onSelectSection: (id: SettingsSectionId) => void
  groups: SettingsNavGroup[]
  collapsed?: boolean
}

export function SettingsSidebar({
  className,
  activeId,
  query,
  onQueryChange,
  onSelectSection,
  groups,
  collapsed = false,
  ...props
}: SettingsSidebarProps) {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-muted/20 text-sm text-foreground",
        collapsed ? "w-14" : "w-[min(16rem,calc(100%-3rem))]",
        className
      )}
      {...props}
    >
      {!collapsed ? (
        <div className="border-b p-3">
          <SearchForm value={query} onValueChange={onQueryChange} />
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div
          className={cn("flex flex-col", collapsed ? "gap-1 p-1" : "gap-4 p-2 pl-0.5")}
        >
          {groups.map((group) => (
            <section key={group.title} className={cn(!collapsed && "px-1")}>
              {!collapsed ? (
                <h2 className="px-2 pb-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                  {group.title}
                </h2>
              ) : null}

              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = activeId === item.id

                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      aria-label={item.title}
                      title={collapsed ? item.title : undefined}
                      onClick={() => onSelectSection(item.id)}
                      className={cn(
                        "flex w-full items-center gap-3 p-2 text-left transition-all duration-100 hover:bg-muted/30 border-l-2 border-transparent",
                        collapsed && "aspect-square justify-center p-0",
                        isActive && "bg-muted! border-l-2 border-primary",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-7 shrink-0 items-center justify-center text-muted-foreground transition-colors",
                          isActive && "text-foreground",
                          collapsed &&
                            "size-9 bg-transparent text-foreground/45 hover:text-foreground/75",
                          collapsed && isActive && "text-foreground"
                        )}
                      >
                        <item.icon className="size-4" />
                      </span>

                      {!collapsed ? (
                        <span className="min-w-0 flex-1 truncate">
                          {item.title}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </ScrollArea>
    </aside>
  )
}
