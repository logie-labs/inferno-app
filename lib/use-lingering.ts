"use client"

import { useState } from "react"

/**
 * Holds on to the last real value, so content survives its own exit animation.
 *
 * Dialogs here are driven by "what is being shown" - a video, a folder, a
 * confirmation - and closing one sets that back to null. Rendering straight
 * from it means the component returns null the instant it closes, unmounting
 * before the fade-out can run: the dialog vanishes rather than dismissing.
 *
 * Keeping the last value lets the content stay on screen while `open` is false,
 * which is exactly the window the exit animation needs. The stale value is only
 * ever read by something already on its way out.
 *
 * Written as an adjustment during render rather than in an effect. React
 * documents this as the way to derive state from a prop, and it re-renders
 * immediately - an effect would paint one frame of the wrong content first,
 * which for a closing dialog means a visible flicker of the previous item.
 */
export function useLingering<T>(value: T | null | undefined): T | null {
  const [kept, setKept] = useState<T | null>(value ?? null)

  if (value != null && value !== kept) {
    setKept(value)
  }

  return value ?? kept
}
