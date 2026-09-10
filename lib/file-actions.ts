/**
 * "Open this file" and "show me where it is", for both products.
 *
 * The desktop hands a path to the OS: the shell opens it in whatever the user
 * has associated, and the file manager can highlight it in its folder. A
 * browser has neither. It has a URL, a new tab, and a download - so the same
 * three intents get different mechanisms, and the call sites should not each
 * have to know which.
 *
 * Everything here is *intent-shaped* for that reason. `openFile` means "let me
 * see this file", not "call ShellExecute". What that turns into is decided
 * once, here, by `capabilities`.
 *
 * The one thing that does not change between products: bytes always come from
 * the API. The desktop opens a local path because it has one, not because it
 * is reading the download directory behind the service's back.
 */

import { capabilities } from "@/lib/deployment"
import {
  InfernoError,
  openPath,
  revealPath,
  type InfernoClient,
  type ServiceFile,
} from "@/lib/inferno-service"

/**
 * What a call site knows about the file it wants to act on.
 *
 * Both halves are optional because which one exists depends on the product:
 * the browser only ever has the API's `url`, and a local path is meaningless
 * to it; the desktop prefers the path, and falls back to the URL if a file was
 * never recorded locally. A caller passes what it has.
 */
export type FileTarget = {
  /** Relative url from the API, as carried on `ServiceFile.url`. */
  url?: string | null
  /** Absolute path on the machine running the service. Desktop only. */
  path?: string | null
  /** For the browser's download filename, and for error messages. */
  name?: string | null
  /**
   * Path relative to the download root, which is what the viewer route is
   * keyed on (`/view/<relativePath>`).
   *
   * Optional because not every caller has it: the browse dialog does - every
   * listing entry carries one - while the queue holds absolute paths from the
   * job API and has to subtract the root, which it can only do once `/health`
   * has reported it. Without one, opening falls back to the raw file URL,
   * which still works and just skips the player.
   */
  relativePath?: string | null
}

export function targetFromServiceFile(file: ServiceFile): FileTarget {
  return { url: file.url, path: file.path, name: file.name }
}

/**
 * An absolute path from the service, expressed relative to the download root.
 *
 * Both come from the same service - `files[].path` and `/health`'s
 * `download_dir` - so this is string arithmetic on two values that already
 * agree, not a guess. Returns null when they do not agree, which happens when a
 * download was placed outside the download folder: the viewer cannot address
 * that file, and callers fall back to the raw URL rather than building a
 * `/view/` link that would 404.
 *
 * Separators are normalised because the service may be running on Windows,
 * where the paths come back with backslashes and the URL needs forward ones.
 */
export function relativeToRoot(
  absolutePath: string | null | undefined,
  root: string | null | undefined
): string | null {
  if (!absolutePath || !root) {
    return null
  }

  const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const file = normalise(absolutePath)
  const base = normalise(root)

  if (file === base || !file.startsWith(`${base}/`)) {
    return null
  }

  return file.slice(base.length + 1)
}

function notAvailable(what: string): never {
  throw new InfernoError({
    code: "not_supported",
    message: `${what} is not available in this version.`,
  })
}

/**
 * Show the file to the person who asked for it.
 *
 * Desktop: the OS opens it in their default application.
 *
 * Browser: a new tab on `/view/<path>`, the app's own viewer, rather than the
 * file URL itself. Handing a browser the raw bytes works for an mp4 and fails
 * silently for everything else - a `.mkv` is either a download prompt or a
 * blank frame, with nothing on the page to say which or why. Since yt-dlp
 * merges to Matroska by default that is the common outcome, not the rare one.
 * The viewer wraps the same bytes in a player and can explain itself when the
 * browser has no decoder.
 *
 * Falls back to the raw URL when the caller has no root-relative path, which
 * is the one thing the viewer route needs. Better a tab that behaves like it
 * used to than an action that does nothing.
 *
 * `noopener,noreferrer` because the opened tab has no business reaching back
 * into this one through `window.opener`.
 */
export async function openFile(client: InfernoClient | null, file: FileTarget) {
  if (capabilities.localFilesystem) {
    return openPath(file.path ?? "")
  }

  if (file.relativePath) {
    const href = `/view/${file.relativePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`
    window.open(href, "_blank", "noopener,noreferrer")

    return
  }

  if (!client || !file.url) {
    notAvailable("Opening this file")
  }

  window.open(client.href(file.url), "_blank", "noopener,noreferrer")
}

/**
 * Save the file to the machine the browser is running on.
 *
 * This is the one action with no desktop equivalent: the file is already on
 * that machine, so "download" would mean copying it beside itself. Call sites
 * gate on `capabilities.downloadToBrowser` rather than calling this and
 * catching.
 *
 * The `download` attribute is what makes the browser save rather than navigate,
 * and it names the saved file - which matters because the URL's last segment is
 * percent-encoded and would otherwise become the filename verbatim. It is
 * honoured only for same-origin URLs, which these are: the frontend is served
 * by the API in the container build, deliberately.
 */
export async function downloadFile(
  client: InfernoClient | null,
  file: FileTarget
) {
  if (!capabilities.downloadToBrowser) {
    notAvailable("Downloading")
  }

  if (!client || !file.url) {
    notAvailable("Downloading this file")
  }

  const anchor = document.createElement("a")
  anchor.href = client.href(file.url)
  anchor.download = file.name ?? ""
  anchor.rel = "noopener"
  // Firefox requires the element to be in the document for a click to count.
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * The desktop half of "show me where this is".
 *
 * The browser half cannot be a function call - it opens a dialog, which is
 * React state that lives in a component tree. Call sites branch on
 * `capabilities.revealInFileManager` and use `useFileBrowser()` instead, so
 * this stays the narrow thing it is rather than growing a callback parameter
 * that only one product ever uses.
 */
export async function revealFile(file: FileTarget) {
  if (!capabilities.revealInFileManager) {
    notAvailable("Revealing files")
  }

  return revealPath(file.path ?? "")
}

/**
 * The folder a path sits in, as the browse API wants it.
 *
 * The API speaks in paths relative to the download root, so this trims the last
 * segment and nothing else. An entry at the root yields "", which is the root -
 * the same value the API uses for it.
 */
export function parentOf(relativePath: string) {
  const trimmed = relativePath.replace(/\/+$/, "")
  const cut = trimmed.lastIndexOf("/")

  return cut === -1 ? "" : trimmed.slice(0, cut)
}
