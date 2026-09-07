import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { keybindParts } from "@/lib/keybinds"
import { cn } from "@/lib/utils"

/**
 * A shortcut, drawn as the keys you actually press.
 *
 * One `Kbd` per key rather than one around the whole chord: `Ctrl + Alt + K` in
 * a single box reads as a piece of text that happens to be in a keycap, while
 * three caps read as three keys. It also survives being wrapped, since each cap
 * is its own inline box.
 *
 * The single place shortcuts are rendered, so the palette, the settings screen
 * and anything added later cannot drift into showing them differently.
 */
export function KeybindDisplay({
  binding,
  className,
  empty = "Not set",
}: {
  binding: string
  className?: string
  /** Shown when there is no shortcut - text, because it is not a key. */
  empty?: string
}) {
  const parts = keybindParts(binding)

  if (parts.length === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {empty}
      </span>
    )
  }

  return (
    <KbdGroup className={className}>
      {parts.map((part, index) => (
        <Kbd key={`${part}-${index}`}>{part}</Kbd>
      ))}
    </KbdGroup>
  )
}
