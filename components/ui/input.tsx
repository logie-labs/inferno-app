import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * The input's own look, kept separate so a field that cannot be an `<input>`
 * can still be one to look at. The token editor is a `contentEditable` - it
 * holds elements, and an input holds only text - and without this it drifted
 * into being a differently shaped control sitting under the real ones.
 */
const inputClassName =
  "h-10 w-full min-w-0 border border-transparent border-b-input bg-transparent px-0 py-1 text-[13px] transition-[color,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-b-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-b-destructive dark:aria-invalid:border-b-destructive/50"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  )
}

export { Input, inputClassName }
