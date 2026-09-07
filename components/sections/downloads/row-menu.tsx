"use client"

import { Fragment, type ComponentType, type ReactElement } from "react"
import { RiMoreFill } from "@remixicon/react"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type RowAction = {
  label: string
  /** Tooltip: the path, the filename, whatever the label had to leave out. */
  hint?: string
  icon: ComponentType<{ className?: string }>
  /** Renders in the destructive tint, icon included. */
  destructive?: boolean
  /**
   * Shown, but not selectable.
   *
   * Greyed out rather than absent on purpose: an action that vanishes for
   * reasons the person cannot see reads as a missing feature. `hint` carries
   * the why, so hovering it answers the question.
   */
  disabled?: boolean
  run: () => void
}

/**
 * The overflow menu shared by queue rows and library rows.
 *
 * Actions arrive already grouped, and the groups are what the separators are
 * drawn from - so a row that has nothing to say in a group simply loses that
 * rule instead of leaving a doubled or leading one. Both row types render
 * through here so the two menus cannot drift apart.
 */
export function RowMenu({ groups }: { groups: RowAction[][] }) {
  const present = groups.filter((group) => group.length > 0)

  if (present.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7 text-muted-foreground"
            aria-label="More actions"
            title="More actions"
          >
            <RiMoreFill className="size-3.5" />
          </Button>
        }
      />

      <DropdownMenuContent align="end" className="w-52">
        {present.map((group, index) => (
          <Fragment key={group[0].label}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((action) => (
              <DropdownMenuItem
                key={action.label}
                title={action.hint}
                disabled={action.disabled}
                variant={action.destructive ? "destructive" : "default"}
                onClick={action.run}
              >
                <action.icon />
                {action.label}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The same actions, reached by right-clicking the row itself.
 *
 * Takes the identical `groups` the overflow button takes, because they are the
 * same menu - a row that offers "Delete" from the corner button and not from a
 * right-click would just be a bug waiting to be reported. Rendering both from
 * one input is what stops that.
 *
 * `render` makes the row *itself* the trigger rather than wrapping it in
 * another element, which would otherwise insert a stray `<div>` into a flex
 * layout that was not expecting one.
 */
export function RowContextMenu({
  groups,
  children,
}: {
  groups: RowAction[][]
  children: ReactElement
}) {
  const present = groups.filter((group) => group.length > 0)

  if (present.length === 0) {
    return children
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-52">
        {present.map((group, index) => (
          <Fragment key={group[0].label}>
            {index > 0 ? <ContextMenuSeparator /> : null}
            {group.map((action) => (
              <ContextMenuItem
                key={action.label}
                title={action.hint}
                disabled={action.disabled}
                variant={action.destructive ? "destructive" : "default"}
                onClick={action.run}
              >
                <action.icon />
                {action.label}
              </ContextMenuItem>
            ))}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
