import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Window caption glyphs from Segoe Fluent Icons (`public/sfi.ttf`, registered
 * as the `font-icon` family in `globals.css`) - the same codepoints Windows
 * itself paints for the title bar buttons.
 *
 * This font is for the window controls only. Everywhere else in the app uses
 * `@remixicon/react`.
 */
export const glyphs = {
  minimize: "\uE921", // ChromeMinimize
  maximize: "\uE922", // ChromeMaximize
  restore: "\uE923", // ChromeRestore
  close: "\uE8BB", // ChromeClose
} as const

export type IconName = keyof typeof glyphs

type IconProps = Omit<React.ComponentProps<"span">, "children"> & {
  name: IconName
}

export function Icon({ name, className, ...props }: IconProps) {
  return (
    <span
      aria-hidden
      data-slot="icon"
      className={cn("pointer-events-none font-icon leading-none", className)}
      {...props}
    >
      {glyphs[name]}
    </span>
  )
}
