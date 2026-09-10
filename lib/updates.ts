"use client"

/**
 * "Is any of this up to date?" - asked of every part the app is made of.
 *
 * An inferno-app install is not one program. It is the desktop shell, the
 * Python service it spawns, the yt-dlp inside that service, and the binaries
 * yt-dlp shells out to. Any one of them can be the reason a download stopped
 * working, and the one that usually is - yt-dlp - is invisible from the About
 * screen. So the check covers the whole inventory rather than the app alone.
 *
 * Two rules run through all of it:
 *
 * 1. **Never invent a comparison.** `current` means a version was actually
 *    measured against a published release and found equal or newer. Anything
 *    without a release to ask about gets a state that says so - `bundled`,
 *    `pinned`, `unknown` - and never `current`. What the screen then *calls*
 *    those is its own business (they read as "Up to date", because none of
 *    them needs anybody to do anything), but the distinction survives in the
 *    data, where the report and the dialog rely on it.
 * 2. **The network is optional.** Every component still reports what is
 *    installed with no connection at all; the remote half only adds the
 *    "and the latest is..." column.
 */

import { useSyncExternalStore } from "react"

import { getAppVersion } from "@/lib/app-version"
import {
  getServiceEndpoint,
  downloadBinary,
  getServiceStatus,
  hashFile,
  InfernoClient,
  vendorPath,
  verifyBinary,
  type Health,
  type ResolvedBinary,
  type ServiceStatus,
} from "@/lib/inferno-service"
import type { SettingsConfig } from "@/components/sections/settings/settings-config"

/** The settings this module reads. Owned by the settings store, as usual. */
export type UpdatePreferences = SettingsConfig["updates"]

export type UpdateComponentId =
  "app" | "service" | "yt-dlp" | "ffmpeg" | "ffprobe" | "js-runtime" | "python"

/**
 * What the check was able to conclude about one component.
 *
 * `current`, `outdated` and `error` are the three that come from actually
 * asking somebody: a release was fetched, or the fetch failed.
 *
 * `bundled` and `pinned` are the ones where nothing was asked, because there
 * is nobody to ask. Both mean "installed, working, no known newer version",
 * and the screen shows them identically for that reason. They stay separate
 * here because the app can replace one and not the other: `bundled` is sealed
 * into the installer and moves when the app moves, while `pinned` came from
 * PATH or an environment variable and will still be sitting there, at that
 * version, after an update. That difference decides which rows the app's own
 * row can account for, and which have to stay in view on their own.
 */
export type UpdateState =
  | "current"
  | "outdated"
  | "bundled"
  | "pinned"
  | "unavailable"
  | "unknown"
  | "error"

/**
 * Which of the screen's three lists a component belongs in.
 *
 * Provenance, not status - it never changes with the answer a check gives.
 *
 * - `app` is the app itself, the row everything else hangs off.
 * - `vendor` is a third-party program shipped beside the app in `vendor/`:
 *   ffmpeg, ffprobe, the JS runtime. Somebody else's release, somebody else's
 *   version number, and a file you can point at - so they are listed.
 * - `inside` is the app's own working parts: the service executable, the
 *   yt-dlp inside it, the Python it is frozen with. Real answers to "what am I
 *   running" and worth reading, but not separate things to keep an eye on, so
 *   they live behind the app's row rather than beside it.
 */
export type ComponentGroup = "app" | "vendor" | "inside"

export type ComponentReport = {
  id: UpdateComponentId
  name: string
  /** What this component does, for someone who has never heard of it. */
  purpose: string
  /** The installed version, or null when nothing could report one. */
  current: string | null
  /** The newest published version, when there is somewhere to ask. */
  latest: string | null
  state: UpdateState
  /** Why the state is what it is. Shown verbatim. */
  message: string | null
  /** Where to go about it - a release page, usually. */
  url: string | null
  /** Where it actually is on disk, for the binaries that have a place. */
  path: string | null
  /**
   * SHA-256 of that file, for the components that are one.
   *
   * The only part of the check that reads the install rather than asking
   * something about it, and the only answer that would notice a binary being
   * swapped underneath a version string that stayed the same. Null when there
   * is no file, or when it could not be read.
   */
  hash: string | null
  /** Which of the three lists this belongs to. See `ComponentGroup`. */
  group: ComponentGroup
}

export type UpdateReport = {
  /** When this ran. Epoch milliseconds. */
  checkedAt: number
  components: ComponentReport[]
}

// --- versions --------------------------------------------------------------

type ParsedVersion = {
  numbers: number[]
  /** "" for a plain release. Lower-cased, so comparison is case-blind. */
  prerelease: string
}

/**
 * The three version dialects in play, read by one parser.
 *
 * `0.1.0` (semver, the app), `2025.09.05.232815` (yt-dlp's date builds) and
 * `7.1-full_build` (an ffmpeg package name) all reduce to a list of numbers
 * and an optional prerelease tag, which is all a comparison needs.
 *
 * Note what is *not* treated as a prerelease: only a leading `-` followed by
 * one of the words that actually means one. `7.1-full_build` is a packaging
 * label, and reading it as a prerelease would rank a real ffmpeg build below a
 * bare `7.1` that nobody publishes.
 */
export function parseVersion(
  raw: string | null | undefined
): ParsedVersion | null {
  if (!raw) {
    return null
  }

  // A leading "v" is GitHub tag decoration; ffmpeg's own tags use "n". Only
  // when a digit follows, so an ffmpeg git build - "N-126308-gd411d9e752" -
  // keeps its leading letter and is rejected below as the non-version it is,
  // rather than being quietly shortened into something that looks parseable.
  const text = String(raw)
    .trim()
    .replace(/^[vn](?=\d)/i, "")
  const core = /^\d+(?:\.\d+)*/.exec(text)?.[0]

  if (!core) {
    return null
  }

  const prerelease =
    /^-((?:alpha|beta|rc|pre|dev|nightly|canary)[\w.]*)/i.exec(
      text.slice(core.length)
    )?.[1] ?? ""

  return {
    numbers: core.split(".").map((part) => Number.parseInt(part, 10)),
    prerelease: prerelease.toLowerCase(),
  }
}

/**
 * `-1` when `a` is older, `0` when they match, `1` when `a` is newer - and
 * `null` when either side is not a version at all, which is the case that
 * matters: an unreadable version has to end up `unknown` rather than quietly
 * comparing as zero and reporting everything up to date.
 *
 * Missing trailing parts count as zero, so `1.2` and `1.2.0` are one release,
 * and a prerelease sorts below the release it leads to.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined
): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)

  if (!left || !right) {
    return null
  }

  const length = Math.max(left.numbers.length, right.numbers.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)

    if (difference !== 0) {
      return difference < 0 ? -1 : 1
    }
  }

  if (left.prerelease === right.prerelease) {
    return 0
  }

  // A finished release outranks its own prereleases.
  if (!left.prerelease) {
    return 1
  }
  if (!right.prerelease) {
    return -1
  }

  return left.prerelease < right.prerelease ? -1 : 1
}

// --- release feeds ---------------------------------------------------------

/** One downloadable file attached to a release. */
export type ReleaseAsset = {
  name: string
  url: string
  /** Bytes, as the release reports them - the divisor for a progress bar. */
  size: number
}

export type Release = {
  version: string
  url: string | null
  /** ISO 8601, as published. */
  publishedAt: string | null
  prerelease: boolean
  assets: ReleaseAsset[]
}

const GITHUB_API = "https://api.github.com"

/**
 * Where this app publishes, when nothing has been set in its place.
 *
 * A build constant rather than a default written into the settings, because it
 * is a fact about this build and not a preference: it should be right for
 * every install, including ones whose stored settings predate it. The setting
 * exists to *override* this - for a fork, or a self-hosted manifest.
 */
export const DEFAULT_APP_REPO = "logie-labs/inferno-app"

/** Long enough for a cold DNS lookup, short enough not to hang a launch. */
const REQUEST_TIMEOUT = 12_000

/** A feed that answered with something other than a release. */
class FeedError extends Error {
  /** The HTTP status, or 0 when the request never got that far. */
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "FeedError"
    this.status = status
  }
}

/**
 * A JSON GET with a deadline and error messages a person can act on.
 *
 * `AbortController` rather than `AbortSignal.timeout`, which not every WebView2
 * build this ships against has. The timer is always cleared - an abort left
 * armed fires into a finished request and, on a slow machine, cancels the
 * *next* one.
 */
async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (cause) {
    throw new FeedError(
      controller.signal.aborted
        ? "The release feed did not answer in time."
        : `Could not reach the release feed. ${
            cause instanceof Error ? cause.message : ""
          }`.trim(),
      0
    )
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 404) {
    throw new FeedError(
      "The release feed was not found. Check the address.",
      404
    )
  }

  if (response.status === 403 || response.status === 429) {
    // GitHub answers 403 for both "rate limited" and "refused", and only the
    // header tells them apart. Saying which decides whether the answer is
    // "wait an hour" or "fix the address".
    throw new FeedError(
      response.headers.get("x-ratelimit-remaining") === "0"
        ? "GitHub's hourly rate limit for this network has been reached. Try again later."
        : "The release feed refused the request.",
      response.status
    )
  }

  if (!response.ok) {
    throw new FeedError(
      `The release feed answered ${response.status}.`,
      response.status
    )
  }

  try {
    return await response.json()
  } catch {
    throw new FeedError("The release feed did not return JSON.", 200)
  }
}

type GithubRelease = {
  tag_name?: string
  name?: string
  html_url?: string
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: Array<{
    name?: string
    browser_download_url?: string
    size?: number
  }>
}

/**
 * The newest release of an `owner/repo`, or null when it has none to give.
 *
 * `/releases/latest` and nothing else: it is GitHub's own answer to this
 * question, and it already skips drafts and prereleases. Finished releases are
 * the only ones anybody is told about here - an update notification is a
 * suggestion to go and install something, and a nightly is not that.
 *
 * Null rather than an error for the empty case, because "no releases yet" is
 * not a fault: a repository that has just been created, or one that is still
 * private, answers exactly like this, and neither deserves a red badge. The
 * two are indistinguishable to an unauthenticated caller - both are a bare
 * 404 - which is why the message the caller shows names both possibilities
 * rather than picking one and being wrong half the time.
 */
async function githubRelease(repo: string): Promise<Release | null> {
  let payload: unknown
  try {
    payload = await getJson(`${GITHUB_API}/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    })
  } catch (error) {
    if (error instanceof FeedError && error.status === 404) {
      return null
    }

    throw error
  }

  const release = Array.isArray(payload)
    ? (payload as GithubRelease[]).find((entry) => !entry.draft)
    : (payload as GithubRelease | null)

  const version = release?.tag_name || release?.name

  // An empty list is the other shape of "nothing published yet".
  if (!version) {
    return null
  }

  return {
    version,
    url: release?.html_url ?? null,
    publishedAt: release?.published_at ?? null,
    prerelease: Boolean(release?.prerelease),
    assets: (release?.assets ?? []).flatMap((asset) =>
      asset?.name && asset?.browser_download_url
        ? [
            {
              name: asset.name,
              url: asset.browser_download_url,
              size: asset.size ?? 0,
            },
          ]
        : []
    ),
  }
}

const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/
const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i

export type FeedKind =
  | {
      kind: "github"
      repo: string
      /** Nothing was set; this is the built-in. */ builtIn: boolean
    }
  | { kind: "json"; url: string }

/**
 * What a typed feed value will actually be asked for.
 *
 * Exported because the settings screen says so under the field. Somebody who
 * pastes a repository URL should be able to see it was understood as a
 * repository before they run a check and wait for a failure.
 *
 * An empty setting is not "no feed" - it is "the one this build ships with".
 * That distinction is what lets the repository move without every existing
 * install being stuck on a stored empty string.
 */
export function describeFeed(feed: string): FeedKind {
  const trimmed = feed.trim()

  if (!trimmed) {
    return { kind: "github", repo: DEFAULT_APP_REPO, builtIn: true }
  }

  if (GITHUB_SHORTHAND.test(trimmed)) {
    return { kind: "github", repo: trimmed, builtIn: false }
  }

  const match = GITHUB_URL.exec(trimmed)
  if (match) {
    return {
      kind: "github",
      repo: `${match[1]}/${match[2].replace(/\.git$/i, "")}`,
      builtIn: false,
    }
  }

  return { kind: "json", url: trimmed }
}

/**
 * The app's own newest release, from whatever the feed points at, or null when
 * that feed has nothing published yet.
 *
 * Three forms are accepted because all three are things somebody will paste:
 * `owner/repo`, a github.com URL, and a plain JSON document. The last is
 * shaped like Tauri's updater manifest (`{ version, notes, pub_date }`), and a
 * bare `{ tag_name }` is read too so a GitHub API URL works as it is.
 */
async function appRelease(feed: string): Promise<Release | null> {
  const target = describeFeed(feed)

  if (target.kind === "github") {
    return githubRelease(target.repo)
  }

  const payload = (await getJson(target.url)) as
    | (GithubRelease & { version?: string; pub_date?: string; url?: string })
    | null

  const version = payload?.version || payload?.tag_name || payload?.name

  if (!version) {
    throw new Error("The release feed named no version.")
  }

  return {
    version,
    url: payload?.html_url ?? payload?.url ?? null,
    publishedAt: payload?.published_at ?? payload?.pub_date ?? null,
    prerelease: Boolean(payload?.prerelease),
    // A hand-written manifest names a version, not a set of files to fetch.
    assets: [],
  }
}

/** yt-dlp publishes here, and nowhere else worth trusting. */
const YT_DLP_REPO = "yt-dlp/yt-dlp"
const YT_DLP_RELEASES = "https://github.com/yt-dlp/yt-dlp/releases"

// --- reading what is installed ---------------------------------------------

/**
 * `/health`, optionally waiting for the service to finish starting.
 *
 * The launch check runs while the sidecar is still coming up, and a check that
 * reported "yt-dlp: not running" every time the app opened would be worse than
 * useless - it would train people to ignore it. So the launch path is allowed
 * to wait; a check somebody asked for by clicking passes zero and reports what
 * is true right now.
 */
async function readHealth(waitMs: number): Promise<Health | null> {
  const deadline = Date.now() + waitMs

  for (;;) {
    const endpoint = await getServiceEndpoint()

    if (endpoint) {
      try {
        return await new InfernoClient(endpoint).health()
      } catch {
        // Not up yet, or not up at all. The deadline decides which.
      }
    }

    if (Date.now() >= deadline) {
      return null
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/** "bundled" and friends, said the way the settings screen says things. */
function describeSource(source: string | null | undefined) {
  switch (source) {
    case "bundled":
      return "Shipped with the app."
    case "env":
      return "Pinned by an environment variable, so the app cannot change it."
    case "path":
      return "Found on this machine's PATH rather than in the bundle, so updating the app will not touch it."
    default:
      return null
  }
}

/**
 * Whether the app owns this copy.
 *
 * `env` and `path` mean somebody else put it there - an override, or whatever
 * happened to be installed - and it will still be there, at that version,
 * after the app updates. That is the whole difference between a row worth
 * folding away and a row worth keeping in front of somebody.
 */
function stateForSource(source: string | null | undefined): UpdateState {
  return source === "env" || source === "path" ? "pinned" : "bundled"
}

/** A binary row: present and versioned, present and mute, or missing. */
function binaryReport(
  id: UpdateComponentId,
  name: string,
  purpose: string,
  binary: ResolvedBinary | undefined,
  serviceUp: boolean,
  /** What its absence costs, when that is worth saying more precisely. */
  whenMissing = "Not found. Downloads that need it will fail until it is installed."
): ComponentReport {
  const base = {
    id,
    name,
    purpose,
    latest: null,
    url: null,
    // Filled in by the caller, which is the only place that can afford to
    // wait for a file to be read end to end.
    hash: null,
    group: "vendor" as const,
  }

  if (!serviceUp) {
    return {
      ...base,
      current: null,
      path: null,
      state: "unknown",
      message: "The service is not running, so this could not be read.",
    }
  }

  if (!binary?.available) {
    return {
      ...base,
      current: null,
      path: null,
      state: "unavailable",
      message: binary?.error || whenMissing,
    }
  }

  return {
    ...base,
    current: binary.version ?? null,
    path: binary.path ?? null,
    state: stateForSource(binary.source),
    message: describeSource(binary.source),
  }
}

// --- the check itself ------------------------------------------------------

/** How the service got here, in one sentence. */
function describeOrigin(status: ServiceStatus | null) {
  switch (status?.origin) {
    case "bundled":
      return "Shipped with the app, so it updates when the app does."
    case "development":
      return "Started from source for development."
    case "attached":
      return "An existing service this app attached to; it updates separately."
    default:
      return "Updates with the app."
  }
}

/**
 * A service the app did not ship is one the app cannot update, so it is
 * `pinned` and stays on screen. Its own bundled copy folds away with the rest.
 */
function stateForOrigin(status: ServiceStatus | null): UpdateState {
  return status?.origin === "attached" ? "pinned" : "bundled"
}

/** The app's own row: the only one with a release to compare against. */
async function appReport(
  preferences: UpdatePreferences,
  installed: string | null
): Promise<ComponentReport> {
  const base = {
    id: "app" as const,
    name: "inferno-app",
    purpose: "The desktop app itself, and everything sealed inside it.",
    current: installed,
    latest: null,
    url: null,
    path: null,
    hash: null,
    group: "app" as const,
  }

  const feed = describeFeed(preferences.feedUrl)

  let release: Release | null
  try {
    release = await appRelease(preferences.feedUrl)
  } catch (error) {
    return {
      ...base,
      state: "error",
      message: error instanceof Error ? error.message : "The check failed.",
    }
  }

  if (!release) {
    // Both readings of an empty answer, because an anonymous caller cannot
    // tell them apart - a private repository 404s exactly like an empty one.
    return {
      ...base,
      state: "unknown",
      message: `No releases were found${
        feed.kind === "github" ? ` in ${feed.repo}` : ""
      }. It may not have published one yet, or may not be public.`,
      url: feed.kind === "github" ? `https://github.com/${feed.repo}` : null,
    }
  }

  const withRelease = { ...base, latest: release.version, url: release.url }

  if (!installed) {
    // Running in a browser against `npm run dev:web`, most likely.
    return {
      ...withRelease,
      state: "unknown",
      message:
        "This build does not report a version, so it cannot be compared with the release.",
    }
  }

  const order = compareVersions(installed, release.version)

  if (order === null) {
    return {
      ...withRelease,
      state: "unknown",
      message: "One of the two versions could not be read as a version.",
    }
  }

  if (order < 0) {
    return {
      ...withRelease,
      state: "outdated",
      message: release.prerelease
        ? "A newer pre-release is available."
        : "A newer release is available.",
    }
  }

  return {
    ...withRelease,
    state: "current",
    message:
      order > 0
        ? "This build is newer than the published release."
        : "Running the latest release.",
  }
}

/** yt-dlp's row - the one that explains most "it stopped working" reports. */
async function ytDlpReport(health: Health | null): Promise<ComponentReport> {
  const base = {
    id: "yt-dlp" as const,
    name: "yt-dlp",
    purpose: "Does the actual extracting and downloading.",
    current: health?.yt_dlp_version ?? null,
    latest: null,
    url: YT_DLP_RELEASES,
    path: null,
    hash: null,
    // A pip package inside the service's exe, not a file of its own.
    group: "inside" as const,
  }

  if (!health) {
    return {
      ...base,
      state: "unknown",
      message: "The service is not running, so its version could not be read.",
    }
  }

  let release: Release | null
  try {
    release = await githubRelease(YT_DLP_REPO)
  } catch (error) {
    return {
      ...base,
      state: "error",
      message: error instanceof Error ? error.message : "The check failed.",
    }
  }

  // yt-dlp has published for years, so an empty answer here is GitHub having
  // a bad day rather than a project that has not shipped yet.
  if (!release) {
    return {
      ...base,
      state: "unknown",
      message: "GitHub returned no releases for yt-dlp.",
    }
  }

  const withRelease = {
    ...base,
    latest: release.version,
    url: release.url ?? base.url,
  }
  const order = compareVersions(base.current, release.version)

  if (order === null) {
    return {
      ...withRelease,
      state: "unknown",
      message: "The installed version could not be read as a version.",
    }
  }

  if (order < 0) {
    return {
      ...withRelease,
      state: "outdated",
      // Said plainly, because the fix is not in this app's hands: yt-dlp is
      // frozen into the service build, so a newer one arrives with a newer app
      // rather than by pressing anything here.
      message:
        "A newer yt-dlp has been released. It ships inside the service, so it arrives with the next app update.",
    }
  }

  return {
    ...withRelease,
    state: "current",
    message:
      order > 0
        ? "Newer than the latest published release."
        : "Running the latest release.",
  }
}

/**
 * Where a bundled copy of each binary sits inside the vendor tree.
 *
 * Plain names, no extension - the Rust side adds `.exe` where that is what a
 * file is called. Only the three that are actually vendored appear here; the
 * service's own executable is not something the app ships a spare of.
 */
const VENDOR_RELATIVE: Partial<Record<UpdateComponentId, string>> = {
  ffmpeg: "ffmpeg/ffmpeg",
  ffprobe: "ffmpeg/ffprobe",
  "js-runtime": "js/qjs",
}

/**
 * The row, after checking the file it names is really there.
 *
 * `/health` is not enough on its own: the service resolves its binaries once
 * at startup and caches the answer, so a file deleted since then still reports
 * as present and the row would sit there saying "Up to date" about something
 * that is gone.
 *
 * When it is gone the row is turned back to missing, which is what starts a
 * repair. Finding the file again does not fix anything by itself: the running
 * service is still pointing at the path it resolved at startup, so a
 * replacement only takes effect on the next launch.
 */
async function verifiedOnDisk(
  component: ComponentReport
): Promise<ComponentReport> {
  const relative = VENDOR_RELATIVE[component.id]

  // Nothing resolved at all, so there is no path to check - `/health` said it
  // could not find the binary anywhere. It may be there now anyway: a repair
  // just put one back, or somebody dropped one in by hand, and the service
  // will not notice either until it restarts. So the destination is checked
  // directly rather than the service's word being taken for it.
  if (!component.path) {
    if (component.state !== "unavailable" || !relative) {
      return component
    }

    const destination = await vendorPath(relative)
    const present = destination ? await verifyBinary(destination) : null

    if (!present) {
      return component
    }

    return {
      ...component,
      path: destination,
      message:
        "The file is in place now, but the service resolved its tools when it started. Restart the app to use it.",
    }
  }

  const present = await verifyBinary(component.path)

  // Null is "could not ask" - a browser, or the command failing - and is not
  // evidence the file has gone. Only an outright `false` is.
  if (present !== false) {
    return component
  }

  return {
    ...component,
    state: "unavailable",
    // The path stays pointed at where the file is *supposed* to be, because
    // that is where the download has to land.
    hash: null,
    // Nothing said about it. A repair starts on its own the moment this is
    // reported, so a sentence announcing one would be narrating something
    // already in hand - and it would be stale a second later. The badge says
    // the file is missing and the fill behind the row says how the replacing
    // is going; between them there is nothing left to write down.
    message: null,
  }
}

/**
 * Where a missing binary is fetched from.
 *
 * The web, always - there is deliberately no copy-it-from-somewhere-else
 * path. A repair that quietly restored a spare would only ever run on a
 * developer's machine, where the checkout has one lying about; every real
 * install has a single vendor directory and nothing to fall back on. So the
 * only route is the one users get, which means it is the one that gets
 * tested.
 *
 * Every source here has to be worth trusting an executable from: a publisher
 * with real releases, and a published digest wherever one exists.
 */
type DownloadSource = {
  repo: string
  /** Picks the one file worth fetching out of a release's assets. */
  asset: (name: string) => boolean
  /**
   * Present when the asset is an archive rather than the binary itself.
   *
   * Lists every component the one download satisfies - ffmpeg's zip carries
   * ffprobe as well - so the pair is fetched once and unpacked into both
   * slots rather than downloading a hundred megabytes twice.
   */
  extract?: UpdateComponentId[]
  /**
   * Where the build's own SHA-256 is published, given the asset's name.
   *
   * Worth the extra request: without it a download is trusted purely because
   * TLS said the host was who it claimed. With it, the bytes have to match a
   * digest the publisher wrote down - and for ffmpeg the digest and the file
   * come from two different hosts, so tampering would have to reach both.
   */
  checksum?: (asset: string) => string
}

const FFMPEG_SOURCE: DownloadSource = {
  // gyan.dev's builds, which is where this project's ffmpeg has always come
  // from - and they are published as GitHub releases with real version tags
  // (`9.0.1`), not a rolling `latest`. That is worth something beyond the
  // download: a tagged build reports a version this app can actually compare,
  // where the git-master builds call themselves `N-126308-gd411d9e752` and
  // cannot be ranked against anything.
  repo: "GyanD/codexffmpeg",
  // `essentials` is the static build - one self-contained exe per tool. The
  // `shared` variants are smaller only because they leave their DLLs beside
  // them, which is more files to place and more ways to half-install.
  asset: (name) => /^ffmpeg-[\d.]+-essentials_build\.zip$/i.test(name),
  extract: ["ffmpeg", "ffprobe"],
  // gyan publishes a digest beside every package. The archive itself is
  // fetched from the GitHub mirror of the same build - identical to the byte -
  // so the two have to agree for the download to be accepted.
  checksum: (asset) =>
    `https://www.gyan.dev/ffmpeg/builds/packages/${asset}.sha256`,
}

const DOWNLOAD_SOURCES: Partial<Record<UpdateComponentId, DownloadSource>> = {
  // Written out rather than reusing `QUICKJS_NG_REPO`, which is declared
  // further down: a `const` read before its own line is a crash at import,
  // not a hoisted undefined.
  "js-runtime": {
    repo: "quickjs-ng/quickjs",
    asset: (name) => name === qjsAssetName(),
  },
  // Both point at the same archive, so repairing either one repairs the pair.
  ffmpeg: FFMPEG_SOURCE,
  ffprobe: FFMPEG_SOURCE,
}

/**
 * Which quickjs-ng build this machine wants.
 *
 * Read off the user agent, which is the only thing a webview will say about
 * the host. It is enough to tell the three desktop platforms apart and to spot
 * 64-bit Windows; it cannot tell an Intel Mac from an Apple Silicon one, so
 * that falls to arm64 - every Mac sold for years. A wrong guess fails at the
 * download rather than producing a binary that will not run: the asset simply
 * is not in the release.
 */
function qjsAssetName() {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent

  if (/windows/i.test(agent)) {
    return /wow64|win64|x64|x86_64/i.test(agent)
      ? "qjs-windows-x86_64.exe"
      : "qjs-windows-x86.exe"
  }

  if (/mac os|macintosh/i.test(agent)) {
    return /intel/i.test(agent) ? "qjs-darwin-x86_64" : "qjs-darwin-arm64"
  }

  return /aarch64|arm64/i.test(agent) ? "qjs-linux-aarch64" : "qjs-linux-x86_64"
}

/**
 * quickjs-ng publishes releases; Bellard's original QuickJS does not.
 *
 * The service already tells the two apart - it has to, because they version
 * themselves differently - and reports which one resolved as `js_runtime.name`.
 * Only the fork gets asked about, because only the fork has anywhere to ask.
 */
const QUICKJS_NG_REPO = "quickjs-ng/quickjs"

/**
 * A binary that does have an upstream, measured against it.
 *
 * ffmpeg and ffprobe get none of this, even though the build they are
 * fetched from does publish releases. They resolve through `env -> bundled ->
 * PATH`, so the copy in use may well be one the machine manages rather than
 * one this app placed, and pressing a rebuild on that is not the app's call.
 * They are fetched when there is nothing there at all, and otherwise left.
 */
async function checkedAgainstRelease(
  component: ComponentReport,
  repo: string
): Promise<ComponentReport> {
  // Nothing installed, or nothing readable: there is no comparison to make,
  // and the row already says why.
  if (
    !component.current ||
    (component.state !== "bundled" && component.state !== "pinned")
  ) {
    return component
  }

  let release: Release | null
  try {
    release = await githubRelease(repo)
  } catch (error) {
    return {
      ...component,
      state: "error",
      message: error instanceof Error ? error.message : "The check failed.",
    }
  }

  if (!release) {
    return component
  }

  const withRelease = {
    ...component,
    latest: release.version,
    url: release.url ?? `https://github.com/${repo}/releases`,
  }
  const order = compareVersions(component.current, release.version)

  if (order === null) {
    return {
      ...withRelease,
      state: "unknown",
      message: "The installed version could not be read as a version.",
    }
  }

  if (order < 0) {
    return {
      ...withRelease,
      state: "outdated",
      // Whose problem it is depends on whose copy it is - and the state going
      // in is the only thing that still knows, since it is about to be
      // overwritten with `outdated`.
      message:
        component.state === "bundled"
          ? "A newer release is available. It ships with the app, so it arrives with the next app update."
          : "A newer release is available. This copy came from outside the app, so updating it is yours to do.",
    }
  }

  return {
    ...withRelease,
    state: "current",
    message:
      order > 0
        ? "Newer than the latest published release."
        : "Running the latest release.",
  }
}

/**
 * The order components are reported in, and everything the screen can know
 * about them before a check has said anything.
 *
 * Exported so a check in progress can be drawn: the screen puts up this list
 * with a spinner against every entry, and swaps each one for its answer as it
 * lands. Without it the first check on a fresh install would have nothing to
 * put a spinner on.
 */
export const COMPONENT_ROSTER: ReadonlyArray<{
  id: UpdateComponentId
  name: string
  purpose: string
  group: ComponentGroup
}> = [
  {
    id: "app",
    name: "inferno-app",
    purpose: "The desktop app itself, and everything sealed inside it.",
    group: "app",
  },
  {
    id: "service",
    name: "inferno-service",
    purpose: "The download backend the app talks to.",
    group: "inside",
  },
  {
    id: "yt-dlp",
    name: "yt-dlp",
    purpose: "Does the actual extracting and downloading.",
    group: "inside",
  },
  {
    id: "python",
    name: "Python",
    purpose: "The runtime the service is built on.",
    group: "inside",
  },
  {
    id: "ffmpeg",
    name: "ffmpeg",
    purpose: "Merges video and audio streams, and converts formats.",
    group: "vendor",
  },
  {
    id: "ffprobe",
    name: "ffprobe",
    purpose: "Reads media details. yt-dlp finds it beside ffmpeg.",
    group: "vendor",
  },
  {
    id: "js-runtime",
    name: "JS runtime",
    purpose: "Runs the player scripts some sites need to hand over a URL.",
    group: "vendor",
  },
]

const ROSTER_ORDER = COMPONENT_ROSTER.map((entry) => entry.id)

/** Told each time part of a check settles, so a screen can follow along. */
export type UpdateProgress = (components: ComponentReport[]) => void

/**
 * Every component, checked.
 *
 * Never rejects. A component that could not be checked says so in its own row
 * rather than taking the report down with it - a rate-limited GitHub must not
 * cost you the ffmpeg answer, which needed no network at all.
 *
 * Answers are handed back through `onProgress` as they arrive rather than only
 * at the end, in waves that reflect what each one is waiting on: the app's
 * release, then what `/health` knows, then each binary as its file finishes
 * hashing, then yt-dlp's release. The app's fetch does not wait for the
 * service, so on a cold launch - where the sidecar can take twenty seconds -
 * the row that matters most is usually answered first.
 *
 * `only` narrows the check to one component, for re-checking a single row.
 * The rest are carried over from `base` untouched, so a partial check still
 * returns a whole report.
 */
export async function runUpdateCheck(
  preferences: UpdatePreferences,
  options: {
    waitForService?: number
    onProgress?: UpdateProgress
    only?: readonly UpdateComponentId[]
    base?: UpdateReport | null
  } = {}
): Promise<UpdateReport> {
  const only = options.only
  const wanted = (id: UpdateComponentId) => !only || only.includes(id)

  // Seeded with what is already known, so a narrowed check does not return a
  // report with holes where the components it skipped used to be.
  const settled = new Map<UpdateComponentId, ComponentReport>(
    (options.base?.components ?? []).map((entry) => [entry.id, entry])
  )

  const emit = (components: ComponentReport[]) => {
    const relevant = components.filter((component) => wanted(component.id))

    if (relevant.length === 0) {
      return
    }

    for (const component of relevant) {
      settled.set(component.id, component)
    }

    options.onProgress?.(relevant)
  }

  // Started together, reported apart. `getAppVersion` is local and instant;
  // `readHealth` may sit waiting for a service that is still starting.
  const appDone = !wanted("app")
    ? Promise.resolve()
    : getAppVersion()
        .then((installed) => appReport(preferences, installed))
        .then((component) => emit([component]))

  // Everything below this point comes from `/health`, so a check narrowed to
  // the app alone can skip the service entirely rather than waiting on it.
  const needsHealth = ROSTER_ORDER.some((id) => id !== "app" && wanted(id))

  const healthDone = !needsHealth
    ? Promise.resolve()
    : Promise.all([
        readHealth(options.waitForService ?? 0),
        getServiceStatus(),
      ]).then(async ([health, status]) => {
        const serviceUp = health !== null

        // Nothing on disk to read for these two, so they are answered outright.
        emit([
          {
            id: "service",
            name: "inferno-service",
            purpose: "The download backend the app talks to.",
            current: health?.version ?? null,
            latest: null,
            state: serviceUp ? stateForOrigin(status) : "unavailable",
            message: serviceUp
              ? describeOrigin(status)
              : "Not running. Downloads cannot start until it is.",
            url: null,
            path: null,
            hash: null,
            group: "inside",
          },
          {
            id: "python",
            name: "Python",
            purpose: "The runtime the service is built on.",
            current: health?.python_version ?? null,
            latest: null,
            state: serviceUp ? "bundled" : "unknown",
            message: serviceUp
              ? "Frozen into the service build."
              : "The service is not running, so this could not be read.",
            url: null,
            path: null,
            hash: null,
            // The interpreter is compiled into the service's exe, not beside it.
            group: "inside",
          },
        ])

        // The binaries, each held back until its own file has been read through.
        //
        // This is the only part of the check that does more than repeat what it
        // was told. `/health` answers these instantly - the service resolved them
        // at startup and has cached the result ever since - which is why they used
        // to settle before anybody could see them move. Hashing the file is the
        // work that would actually notice one being swapped, and it takes long
        // enough on an 80 MB executable to be worth showing.
        await Promise.all(
          [
            binaryReport(
              "ffmpeg",
              "ffmpeg",
              "Merges video and audio streams, and converts formats.",
              health?.ffmpeg,
              serviceUp
            ),
            binaryReport(
              "ffprobe",
              "ffprobe",
              "Reads media details. yt-dlp finds it beside ffmpeg.",
              health?.ffprobe,
              serviceUp
            ),
            binaryReport(
              "js-runtime",
              health?.js_runtime?.name ?? "JS runtime",
              "Runs the player scripts some sites need to hand over a URL.",
              health?.js_runtime,
              serviceUp,
              "Not found. Some sites will refuse to hand over a download URL."
            ),
          ]
            // Filtered before the hashing rather than inside `emit`, so a check
            // narrowed to one binary does not read the other two end to end for
            // an answer it is going to throw away.
            .filter((component) => wanted(component.id))
            .map(async (component) => {
              // Existence first: there is no sense hashing a file that is not
              // there, and a missing one has a different answer entirely.
              const present = await verifiedOnDisk(component)
              const hashed = {
                ...present,
                hash:
                  present.path && present.state !== "unavailable"
                    ? await hashFile(present.path)
                    : null,
              }

              // The JS runtime is the one binary here with a published
              // upstream, so it gets a real comparison rather than only a
              // digest - but only the `-ng` fork, which is the only one that
              // cuts releases. The row stays spinning through both.
              emit([
                component.id === "js-runtime" &&
                (health?.js_runtime?.name ?? "").toLowerCase().includes("-ng")
                  ? await checkedAgainstRelease(hashed, QUICKJS_NG_REPO)
                  : hashed,
              ])
            })
        )

        // Needs the version `/health` just reported, so it waits on this wave.
        emit([await ytDlpReport(health)])
      })

  await Promise.all([appDone, healthDone])

  return {
    // A report is only as fresh as its oldest row, so re-checking one
    // component does not restamp the whole thing as just-checked.
    checkedAt: only ? (options.base?.checkedAt ?? Date.now()) : Date.now(),
    // Roster order, not settling order - a list that reshuffles itself
    // according to which network call happened to answer first is a list
    // nobody can read twice.
    components: ROSTER_ORDER.map((id) => settled.get(id)).filter(
      (entry): entry is ComponentReport => entry !== undefined
    ),
  }
}

/** The rows that are actually behind something. */
export function outdatedComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state === "outdated") ?? []
}

/** The rows the check could not complete. */
export function failedComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state === "error") ?? []
}

/** The rows that should be installed and are not. Worth its own line. */
export function missingComponents(report: UpdateReport | null) {
  return (
    report?.components.filter((entry) => entry.state === "unavailable") ?? []
  )
}

/**
 * The rows sealed into the installer, which the screen keeps behind the app.
 *
 * They are not unimportant - they are the answer to "what am I actually
 * running" - but not one of them can be acted on separately, so listing them
 * beside the app's own row only buries it. The Updates screen shows them by
 * opening the app's row instead, which is the question they answer: these are
 * what the app *is*, and updating it updates all of them at once.
 */
export function bundledComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state === "bundled") ?? []
}

/** Everything else: the app, whatever is tracked, and anything wrong. */
export function trackedComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state !== "bundled") ?? []
}

/**
 * Every row a screen can draw, in roster order and never short.
 *
 * Roster order rather than whatever order the answers arrived in, and padded
 * with a placeholder for anything not yet reported, so a check in progress
 * draws the same list it will end with instead of growing a row at a time.
 *
 * All of them, including the ones that live behind the app's row - splitting
 * them up is the screen's job, and it does it by `group`.
 */
export function displayComponents(
  report: UpdateReport | null
): ComponentReport[] {
  const byId = new Map(
    (report?.components ?? []).map((entry) => [entry.id, entry])
  )

  return COMPONENT_ROSTER.map(
    (entry) =>
      byId.get(entry.id) ?? {
        ...entry,
        current: null,
        latest: null,
        state: "unknown",
        message: null,
        url: null,
        path: null,
        hash: null,
      }
  )
}

/** The rows of one group, ready to render. */
export function componentsInGroup(
  report: UpdateReport | null,
  group: ComponentGroup
) {
  return displayComponents(report).filter((entry) => entry.group === group)
}

/** The shape `versionReport` produces. Stable enough to parse. */
export type VersionReport = {
  report: "inferno-app version report"
  /** Schema version, so a reader can tell an old paste from a new one. */
  schema: 1
  /** When the report was written out. */
  generatedAt: string
  /** When the check it describes actually ran. */
  checkedAt: string
  feed: FeedKind
  environment: {
    /** Identifies the webview, which is half of any UI bug report. */
    userAgent: string | null
  }
  summary: {
    components: number
    outdated: number
    missing: number
    failed: number
    bundled: number
  }
  components: Array<{
    id: UpdateComponentId
    name: string
    state: UpdateState
    current: string | null
    latest: string | null
    message: string | null
    path: string | null
    hash: string | null
    group: ComponentGroup
  }>
}

/**
 * The whole check as JSON, for pasting into a bug report.
 *
 * JSON rather than prose because the audience is a maintainer reading somebody
 * else's install: it survives being quoted, it can be diffed against another
 * report, and nothing in it has to be guessed at from a sentence.
 *
 * Every component is here, the bundled ones included - the screen keeps those
 * behind the app's row, but "what exactly are you running" is the whole
 * question the moment something is broken, and that is a different audience
 * from somebody glancing at whether they need to update.
 *
 * `purpose` and `url` are left out on purpose: both are fixed UI copy that
 * would be identical in every report ever pasted, and would bury the handful
 * of fields that actually differ between two machines.
 */
export function versionReport(report: UpdateReport, feed: FeedKind): string {
  const payload: VersionReport = {
    report: "inferno-app version report",
    schema: 1,
    generatedAt: new Date().toISOString(),
    checkedAt: new Date(report.checkedAt).toISOString(),
    feed,
    environment: {
      userAgent:
        typeof navigator === "undefined" ? null : (navigator.userAgent ?? null),
    },
    summary: {
      components: report.components.length,
      outdated: outdatedComponents(report).length,
      missing: missingComponents(report).length,
      failed: failedComponents(report).length,
      bundled: bundledComponents(report).length,
    },
    components: report.components.map((entry) => ({
      id: entry.id,
      name: entry.name,
      state: entry.state,
      current: entry.current,
      latest: entry.latest,
      message: entry.message,
      path: entry.path,
      hash: entry.hash,
      group: entry.group,
    })),
  }

  return JSON.stringify(payload, null, 2)
}

// --- the stored result, and who is listening -------------------------------

const lastCheckStorageKey = "inferno-app.updates.last-check"
const changedEvent = "inferno-app:update-check-changed"

export type UpdateCheckState = {
  /**
   * The last completed check - or, while one is running, that check filling
   * in. Rows keep their previous answers until a new one replaces them, so
   * the list never blanks and then repopulates.
   */
  report: UpdateReport | null
  /** Whether one is running right now. */
  checking: boolean
  /** Which components are still waiting on an answer, for their spinners. */
  pending: readonly UpdateComponentId[]
  /** Which components are being fetched right now. */
  repairing: readonly UpdateComponentId[]
}

/**
 * Which components have a check out on them right now.
 *
 * A set rather than a single in-flight promise, because checks are no longer
 * one at a time: right-clicking three rows in a row starts three, and each
 * only owns the components it asked for. What stops two of them colliding is
 * that a component already in here is never handed to a second check.
 */
const claimed = new Set<UpdateComponentId>()
let pending: readonly UpdateComponentId[] = []
/** How many checks are out, so the last one home knows to write the result. */
let running = 0
/**
 * The report every check in flight is folding its answers into.
 *
 * One shared object rather than one per check, and written to storage only
 * when the last of them finishes. Two concurrent checks each storing their own
 * merged copy would have the slower one overwrite the faster one's rows with
 * the stale versions it started from.
 */
let live: UpdateReport | null = null
/** Handed back to a caller whose components are already spoken for. */
let latest: Promise<UpdateReport> | null = null

/**
 * Bumped by every announcement.
 *
 * `getSnapshot` has to hand React a stable object, and while a check is
 * running the thing that changes is module state rather than the stored JSON -
 * so the cache is keyed on this as well as on what is in storage.
 */
let revision = 0

function announce() {
  revision += 1

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(changedEvent))
  }
}

/** The running report with one wave of answers folded in, in roster order. */
function foldIn(
  base: UpdateReport | null,
  components: ComponentReport[]
): UpdateReport {
  const byId = new Map(
    (base?.components ?? []).map((entry) => [entry.id, entry])
  )

  for (const component of components) {
    byId.set(component.id, component)
  }

  return {
    checkedAt: base?.checkedAt ?? Date.now(),
    components: ROSTER_ORDER.map((id) => byId.get(id)).filter(
      (entry): entry is ComponentReport => entry !== undefined
    ),
  }
}

function safeParse(raw: string): UpdateReport | null {
  try {
    const parsed = JSON.parse(raw) as UpdateReport

    // A report stored by an older build may be missing either half, and both
    // are needed to render a row - a partial one would render as blanks.
    return typeof parsed?.checkedAt === "number" &&
      Array.isArray(parsed?.components)
      ? parsed
      : null
  } catch {
    return null
  }
}

function storeReport(report: UpdateReport) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(lastCheckStorageKey, JSON.stringify(report))
  announce()
}

export function loadLastCheck(): UpdateReport | null {
  if (typeof window === "undefined") {
    return null
  }

  const raw = window.localStorage.getItem(lastCheckStorageKey)

  return raw ? safeParse(raw) : null
}

/**
 * Run a check and remember the result.
 *
 * Several can be out at once - one per row, if somebody works down the list
 * right-clicking - and they share one report rather than each keeping their
 * own. What is *not* allowed is two checks on the same component: whoever
 * asked second is handed the first one's promise, so a doubled click costs one
 * request rather than two against GitHub's unauthenticated rate limit.
 *
 * The last check home writes the result. Storing per-check would let a slow
 * one finish after a fast one and overwrite its rows with the stale versions
 * it had started from.
 */
export function checkForUpdates(
  preferences: UpdatePreferences,
  options: {
    waitForService?: number
    only?: readonly UpdateComponentId[]
    /** Skip the repair pass. Set by the re-check a repair itself runs. */
    skipRepair?: boolean
  } = {}
): Promise<UpdateReport> {
  const requested = options.only ?? ROSTER_ORDER
  const targets = requested.filter((id) => !claimed.has(id))

  // Everything asked for is already being looked at. Nothing to start, and
  // the answer is whatever the check that owns them resolves to.
  if (targets.length === 0) {
    return latest ?? Promise.resolve(live ?? loadLastCheck() ?? emptyReport())
  }

  // Only the first check in seeds the shared report - the ones that join it
  // must not reset it back to what is on disk and lose the rows already
  // answered. Starting from the last answer rather than from nothing is what
  // lets a re-check show the previous versions with spinners over them
  // instead of emptying the screen and filling it back in.
  if (running === 0) {
    live = loadLastCheck()
  }

  running += 1
  for (const id of targets) {
    claimed.add(id)
  }
  pending = [...claimed]
  announce()

  const settle = (components: ComponentReport[]) => {
    live = foldIn(live, components)

    for (const component of components) {
      claimed.delete(component.id)
    }

    pending = [...claimed]
    announce()
  }

  const promise = runUpdateCheck(preferences, {
    ...options,
    only: targets,
    base: live,
    onProgress: settle,
  })
    .then(async (report) => {
      // A whole check is what makes the report freshly dated; a narrowed one
      // leaves the timestamp where it was, because most of it is untouched.
      live = foldIn(live, report.components)
      if (!options.only) {
        live = { ...live, checkedAt: report.checkedAt }
      }

      // Repairs run here, on the finished report, rather than as each answer
      // landed. Components are reported one at a time, so a repair started
      // mid-check saw a half-written picture: ffmpeg would go missing, start
      // its own repair, and read ffprobe's *previous* state - still fine,
      // because ffprobe's answer had not arrived yet - and so leave it behind.
      // Waiting for the whole report is what makes "both are missing" a thing
      // the repair can actually see.
      //
      // Awaited, so a check does not resolve until the install is in the state
      // it is about to report.
      if (!options.skipRepair) {
        await repairMissing(live, preferences)
      }

      return live
    })
    .finally(() => {
      running -= 1

      // Anything this check claimed and never answered - it threw, or the
      // component was skipped - is released here so a later one can try it.
      for (const id of targets) {
        claimed.delete(id)
      }

      pending = [...claimed]

      if (running === 0 && live) {
        storeReport(live)
        // Cleared after the write, so the snapshot falls back to the freshly
        // stored report rather than to the one it replaced.
        live = null
        latest = null
      }

      announce()
    })

  latest = promise

  return promise
}

/** A report about nothing, for the callers that must be handed one. */
function emptyReport(): UpdateReport {
  return { checkedAt: Date.now(), components: [] }
}

// --- putting a missing file back -------------------------------------------

/**
 * Components a repair is running for right now.
 *
 * Claimed synchronously the moment a repair is entered, before anything is
 * awaited, which is what stops the automatic trigger from starting the same
 * work twice. It matters most for ffmpeg, whose archive also carries ffprobe:
 * both are queued together, and without a synchronous claim both would reach
 * the download and fetch the same hundred megabytes.
 */
const inProgress = new Set<UpdateComponentId>()

/** `inProgress` as something the snapshot can hand out by reference. */
let repairing: readonly UpdateComponentId[] = []

function claimRepair(ids: readonly UpdateComponentId[], claimed: boolean) {
  for (const id of ids) {
    if (claimed) {
      inProgress.add(id)
    } else {
      inProgress.delete(id)
    }
  }

  repairing = [...inProgress]
  announce()
}

/**
 * Put one group of missing binaries back, by fetching them.
 *
 * A group is the set of components a single download would satisfy - ffmpeg's
 * archive carries ffprobe - narrowed to the ones actually missing. Passing
 * them together is what lets one fetch serve both, and what stops a repair
 * from touching a file that was never broken.
 *
 * Nothing is reported as it goes. One archive serving two binaries means one
 * transfer and one number, and putting that number behind both rows drew two
 * bars advancing in lockstep, which reads as a rendering fault rather than as
 * a download. The rows say they are downloading and leave it at that.
 *
 * Nothing here is gated on having been tried before. A repair that worked
 * leaves the files on disk and the next pass sees that and stops; a repair
 * that failed simply gets tried again by the next check.
 */
async function repairGroup(group: readonly UpdateComponentId[]): Promise<void> {
  const covered = group.filter((id) => !inProgress.has(id))

  if (covered.length === 0) {
    return
  }

  const id = covered[0]
  const source = DOWNLOAD_SOURCES[id]
  const report = live ?? loadLastCheck()

  // Claimed before the first await, so a second pass finds the work taken.
  claimRepair(covered, true)

  try {
    // Every component this repair is for, and where each one belongs. One
    // archive can land in several places - ffmpeg's zip carries ffprobe - so
    // each needs its own destination resolved. The earlier version resolved
    // only the first, which is why a pair that went missing together came
    // back one at a time.
    const targets = (
      await Promise.all(
        covered.map(async (other) => {
          const otherRelative = VENDOR_RELATIVE[other]

          if (!otherRelative) {
            return null
          }

          // Where the file was, if the service ever managed to resolve one -
          // and otherwise where it goes. The second case is the common one: a
          // binary that was never found has no path to put back, only a place
          // it belongs.
          const known = report?.components.find(
            (entry) => entry.id === other
          )?.path
          const destination = known ?? (await vendorPath(otherRelative))

          return destination
            ? { id: other, relative: otherRelative, destination }
            : null
        })
      )
    ).filter((target) => target !== null)

    // Anything already on disk needs nothing doing to it. The row can still
    // say it is downloading - the service resolved its paths at startup and
    // only a restart changes that - and fetching a file that exists would
    // achieve nothing except starting this again on the check that followed.
    const outstanding: typeof targets = []

    for (const target of targets) {
      if ((await verifyBinary(target.destination)) !== true) {
        outstanding.push(target)
      }
    }

    if (outstanding.length === 0) {
      return
    }

    // Nowhere trustworthy to ask.
    if (!source) {
      throw new Error(
        `There is no source this build can fetch ${outstanding.map((target) => target.id).join(", ")} from.`
      )
    }

    const release = await githubRelease(source.repo)
    const asset = release?.assets.find((entry) => source.asset(entry.name))

    if (!asset) {
      throw new Error(
        `${source.repo}'s latest release has no file this build can use.`
      )
    }

    // Unpacked into the slots that are empty, not into every slot the archive
    // happens to contain. An ffprobe that was never missing is left alone -
    // replacing it would change a file nobody asked about and leave the hash
    // on screen describing the copy that used to be there.
    const members = source.extract
      ? outstanding.map((target) => ({
          name: fileNameOf(target.destination),
          destination: target.destination,
        }))
      : []

    await downloadBinary(
      outstanding[0].destination,
      asset.url,
      undefined,
      members.length > 0 ? members : undefined,
      source.checksum?.(asset.name)
    )

    // No re-check here. `repairMissing` does one for every group it ran, in
    // one pass, with repairs switched off - doing it per group would mean a
    // check per group, and one of them recursing back into repairing.
  } catch (error) {
    // Nobody asked for this, so nobody is waiting on a dialog about it. The
    // row still reads as missing, which is the honest state, and the next
    // check will try again.
    console.warn(`Could not put ${id} back:`, error)
  } finally {
    claimRepair(covered, false)
  }
}

/** The last segment of a path, whichever slash the platform uses. */
function fileNameOf(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Put back everything a finished check found missing, then look again.
 *
 * Run once, on the whole report, which is the point. Repairing as each answer
 * arrived meant deciding what a repair covered from a half-written picture -
 * ffmpeg would go missing, start repairing, and read ffprobe as still fine
 * because ffprobe's answer had not landed yet. Both were deleted; only one
 * came back.
 *
 * Automatic because a missing binary is not a decision to put to anybody: it
 * is broken, and the fix is a download the app already knows how to do.
 */
async function repairMissing(
  report: UpdateReport | null,
  preferences: UpdatePreferences
): Promise<void> {
  // Deliberately not conditional on a component having a path. The case that
  // matters most is the one where the service resolved nothing at all and
  // reported none - a binary missing outright rather than missing from where
  // it was, and the one most worth putting back.
  const missing = (report?.components ?? []).filter(
    (entry) => entry.state === "unavailable" && VENDOR_RELATIVE[entry.id]
  )

  if (missing.length === 0) {
    return
  }

  const handled = new Set<UpdateComponentId>()
  const attempted: UpdateComponentId[] = []

  for (const component of missing) {
    if (handled.has(component.id)) {
      continue
    }

    // Everything one download would satisfy, narrowed to what is missing.
    // Grouped here, where the whole report is known, so a pair that went
    // missing together is one fetch rather than two.
    const source = DOWNLOAD_SOURCES[component.id]
    const group = [
      component.id,
      ...(source?.extract ?? []).filter(
        (other) =>
          other !== component.id && missing.some((entry) => entry.id === other)
      ),
    ]

    for (const id of group) {
      handled.add(id)
    }

    await repairGroup(group)
    attempted.push(...group)
  }

  if (attempted.length === 0) {
    return
  }

  // Look again at what was touched, so the check finishes describing the
  // install as it now is. `skipRepair` because this pass has already done
  // everything it can - without it, a component that could not be put back
  // would start the whole thing over.
  await checkForUpdates(preferences, {
    only: attempted,
    skipRepair: true,
  }).catch(() => {})
}

/**
 * Subscribe to the last result, and to whether a check is running.
 *
 * The same shape as the settings store, for the same reason: the report lives
 * in `localStorage`, which is an external store, and reading it in an effect
 * would render once empty and again with the real thing.
 */
const idleState: UpdateCheckState = {
  report: null,
  checking: false,
  pending: [],
  repairing: [],
}

let snapshotSource: string | null = null
let snapshotRevision = -1
let snapshotValue: UpdateCheckState = idleState

function getSnapshot(): UpdateCheckState {
  const raw = window.localStorage.getItem(lastCheckStorageKey)

  // Rebuilt only when something it is made of moved - `getSnapshot` has to
  // return a stable reference, or React re-renders forever.
  if (raw !== snapshotSource || revision !== snapshotRevision) {
    snapshotSource = raw
    snapshotRevision = revision
    snapshotValue = {
      report: live ?? (raw ? safeParse(raw) : null),
      checking: running > 0,
      pending,
      repairing,
    }
  }

  return snapshotValue
}

/** Prerendered by `output: "export"`, where there is no storage to read. */
function getServerSnapshot(): UpdateCheckState {
  return idleState
}

function subscribe(onChange: () => void) {
  window.addEventListener(changedEvent, onChange)
  // A second window running its own check.
  window.addEventListener("storage", onChange)

  return () => {
    window.removeEventListener(changedEvent, onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function useUpdateCheck(): UpdateCheckState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * "Somebody asked for a check" - raised by the command menu, answered by the
 * watcher at the app root.
 *
 * An event rather than a direct call because the two live in different trees:
 * the palette would otherwise have to hold the check's state and its
 * notification, which is the watcher's whole job. Same shape as the palette's
 * other reach-across commands.
 */
export const updateCheckRequestEvent = "inferno-app:check-updates"

export function requestUpdateCheck() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(updateCheckRequestEvent))
  }
}

/** "just now", "6 minutes ago", "3 days ago" - for the last-checked line. */
export function describeAge(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))

  if (seconds < 45) {
    return "just now"
  }

  // Climbed one unit at a time, stopping at the first that does not fill.
  const steps: Array<[number, string]> = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [7, "week"],
  ]

  let value = seconds
  let unit = "second"

  for (const [size, name] of steps) {
    if (value < size) {
      break
    }

    value = Math.round(value / size)
    unit = name
  }

  return `${value} ${unit}${value === 1 ? "" : "s"} ago`
}
