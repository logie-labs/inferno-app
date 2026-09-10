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
 * Which fields exist depends on the product and the call site: the desktop has
 * an absolute `path` and prefers it, while the browser needs a path relative to
 * the download root. A caller passes what it has, and `contentPath` decides
 * what to do with it.
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
   * has reported it. Without one, `contentPath` falls back to the bare name.
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
 * How to address a finished file, in preference order.
 *
 * The job's own url - `/api/v1/downloads/{id}/files/{name}` - is the obvious
 * choice and the wrong one. Jobs live in memory and do not survive a restart
 * (SPEC §2); the file on the volume does. So that url starts returning
 * `job_not_found` while the file it names is still sitting there, and a tab
 * left open across a service restart turns every Open and Download into a page
 * of raw JSON. The file's own path has no such expiry.
 *
 * Falling back to the bare name is a guess - it assumes the download landed in
 * the root rather than a subfolder - but a checked one: the viewer lists the
 * folder and says so plainly when the file is not there, which is a better
 * outcome than an error envelope rendered as a document.
 */
function contentPath(file: FileTarget): string | null {
  return file.relativePath ?? file.name ?? null
}

/** The API url that serves a file's bytes, keyed on path rather than job. */
export function contentUrl(file: FileTarget): string | null {
  const path = contentPath(file)

  return path
    ? `/api/v1/files/content?path=${encodeURIComponent(path)}`
    : (file.url ?? null)
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
 * Always the viewer, never the job's own url. That url expires when the job
 * does - which is on every service restart, jobs being in memory - while the
 * file it names is still on the volume, so it turns into a page of raw JSON
 * exactly when someone returns to a tab they left open. `contentPath` explains
 * the ordering.
 *
 * `noopener,noreferrer` because the opened tab has no business reaching back
 * into this one through `window.opener`.
 */
export async function openFile(client: InfernoClient | null, file: FileTarget) {
  if (capabilities.localFilesystem) {
    return openPath(file.path ?? "")
  }

  const path = contentPath(file)

  if (!path) {
    notAvailable("Opening this file")
  }

  const href = `/view/${path.split("/").map(encodeURIComponent).join("/")}`
  window.open(href, "_blank", "noopener,noreferrer")
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

  const url = contentUrl(file)

  if (!client || !url) {
    notAvailable("Downloading this file")
  }

  const anchor = document.createElement("a")
  anchor.href = client.href(url)
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
