"use client"

import { useEffect } from "react"

/**
 * Suppresses the browser's own context menu, except where it is the right tool.
 *
 * A desktop app that opens Chromium's "Back / Reload / Inspect" menu on a
 * right-click is showing you the seams. So the default is off, and a
 * right-click means whatever the thing under the cursor says it means - a queue
 * row offers its actions, and empty space offers nothing at all rather than a
 * menu about the browser.
 *
 * Two deliberate exceptions, both about text:
 *
 * - **Editable fields.** This app is one long paste operation. Removing
 *   right-click paste from the URL bar to tidy up a menu nobody looks at would
 *   be a bad trade, and a hand-written Cut/Copy/Paste is worse than the real
 *   one: the native menu knows the selection, the clipboard's contents and the
 *   platform's own wording, and needs no clipboard permission to do it.
 * - **A live text selection.** Right-clicking selected text to copy it is the
 *   same reflex, and the menu the OS provides is the one people expect.
 *
 * Nothing here fights the custom menus. Base UI's `ContextMenu.Trigger` calls
 * `preventDefault()` on the event as it handles it, and this listener runs
 * afterwards on the way up, so an already-handled right-click is left alone.
 */
export function ContextMenuGuard() {
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      // A custom menu already claimed it.
      if (event.defaultPrevented) {
        return
      }

      const target = event.target
      if (target instanceof HTMLElement) {
        const editable =
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA"
        if (editable) {
          return
        }
      }

      // `toString()` rather than `isCollapsed`: a caret placed in text is a
      // selection object too, and only a non-empty one is worth a menu.
      if (window.getSelection()?.toString()) {
        return
      }

      event.preventDefault()
    }

    window.addEventListener("contextmenu", onContextMenu)

    return () => {
      window.removeEventListener("contextmenu", onContextMenu)
    }
  }, [])

  return null
}
