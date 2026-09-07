"use client"

import { cn } from "@/lib/utils"

/**
 * The canvas's text affordance: bare label, optionally sitting on a 1px rule,
 * that lights up on hover. No shadcn variant matches it - `link` underlines the
 * text itself, and every `Button` size carries horizontal padding, which pushes
 * these out of alignment with the panel gutter they are supposed to sit flush
 * against.
 */
export function RuleButton({
  children,
  className,
  onClick,
  mono = false,
  rule = true,
  disabled = false,
}: {
  children: React.ReactNode
  className?: string
  onClick?: () => void
  mono?: boolean
  rule?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "self-start text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
        rule &&
          "border-b border-border pb-0.5 hover:border-foreground focus-visible:border-foreground",
        mono
          ? "font-mono text-[10px] tracking-[0.08em] uppercase"
          : "text-[10px] font-semibold tracking-widest uppercase",
        className
      )}
    >
      {children}
    </button>
  )
}
