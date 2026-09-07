import type { Window } from "@tauri-apps/api/window"

/**
 * Thin wrapper around the current Tauri window that stays safe outside of
 * Tauri - `npm run dev:web` serves the same bundle in a plain browser, where
 * `getCurrentWindow()` throws. Every call no-ops there instead.
 */

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function currentWindow(): Promise<Window | null> {
  if (!inTauri()) {
    return null
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window")

  return getCurrentWindow()
}

export const tauriWindow = {
  minimize: async () => {
    await (await currentWindow())?.minimize()
  },
  toggleMaximize: async () => {
    await (await currentWindow())?.toggleMaximize()
  },
  close: async () => {
    await (await currentWindow())?.close()
  },
  isMaximized: async () => {
    return (await (await currentWindow())?.isMaximized()) ?? false
  },
  /**
   * Subscribes to window resizes. Returns a synchronous cleanup function so it
   * can be handed straight back from a `useEffect`, even though the underlying
   * listener is registered asynchronously.
   */
  onResize: (handler: () => void) => {
    let unlisten: (() => void) | undefined
    let cancelled = false

    void currentWindow().then(async (appWindow) => {
      if (!appWindow) {
        return
      }

      const stop = await appWindow.onResized(handler)

      if (cancelled) {
        stop()
      } else {
        unlisten = stop
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  },
}
