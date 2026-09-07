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
 * 1. **Never claim a version is fine.** Anything with no source to compare
 *    against reports `unknown` or `bundled`, never `current`. A tick nobody
 *    earned is worse than no tick.
 * 2. **The network is optional.** Every component still reports what is
 *    installed with no connection at all; the remote half only adds the
 *    "and the latest is..." column.
 */

import { useSyncExternalStore } from "react"

import { getAppVersion } from "@/lib/app-version"
import {
  getServiceEndpoint,
  getServiceStatus,
  InfernoClient,
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
 * The distinction that shapes the whole screen is `bundled` against everything
 * else. `bundled` means the thing is sealed inside the installer: it is
 * present, its version is known, and it moves when the app moves, so it can
 * never be behind on its own. Those rows are the ones worth folding away -
 * updating the app updates all of them at once.
 *
 * `pinned` is the opposite and looks deceptively similar: also installed, also
 * not compared against anything, but resolved from PATH or an environment
 * variable rather than the bundle. Updating the app will not touch it, so it
 * stays in view.
 *
 * `bundled` is deliberately not `current`, which is reserved for "compared
 * against a published release and found equal or newer".
 */
export type UpdateState =
  | "current"
  | "outdated"
  | "bundled"
  | "pinned"
  | "unavailable"
  | "unknown"
  | "error"

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

  // A leading "v" is GitHub tag decoration; ffmpeg's own tags use "n".
  const text = String(raw)
    .trim()
    .replace(/^[vn]\.?/i, "")
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

export type Release = {
  version: string
  url: string | null
  /** ISO 8601, as published. */
  publishedAt: string | null
  prerelease: boolean
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
  serviceUp: boolean
): ComponentReport {
  const base = { id, name, purpose, latest: null, url: null }

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
      message:
        binary?.error ||
        "Not found. Downloads that need it will fail until it is installed.",
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
 * Every component, checked.
 *
 * Never rejects. A component that could not be checked says so in its own row
 * rather than taking the report down with it - a rate-limited GitHub must not
 * cost you the ffmpeg answer, which needed no network at all.
 */
export async function runUpdateCheck(
  preferences: UpdatePreferences,
  options: { waitForService?: number } = {}
): Promise<UpdateReport> {
  const [installed, health, status] = await Promise.all([
    getAppVersion(),
    readHealth(options.waitForService ?? 0),
    getServiceStatus(),
  ])

  // The two network calls run together; everything else is already in hand.
  const [app, ytDlp] = await Promise.all([
    appReport(preferences, installed),
    ytDlpReport(health),
  ])

  const serviceUp = health !== null

  return {
    checkedAt: Date.now(),
    components: [
      app,
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
      },
      ytDlp,
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
      {
        id: "js-runtime",
        name: health?.js_runtime?.name ?? "JS runtime",
        purpose: "Runs the player scripts some sites need to hand over a URL.",
        current: health?.js_runtime?.version ?? null,
        latest: null,
        state: !serviceUp
          ? "unknown"
          : health?.js_runtime?.available
            ? stateForSource(health.js_runtime.source)
            : "unavailable",
        message: !serviceUp
          ? "The service is not running, so this could not be read."
          : health?.js_runtime?.available
            ? describeSource(health.js_runtime.source)
            : "Not found. Some sites will refuse to hand over a download URL.",
        url: null,
        path: health?.js_runtime?.path ?? null,
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
      },
    ],
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
 * The rows sealed into the installer, which the screen folds away.
 *
 * They are not unimportant - they are the answer to "what am I actually
 * running" - but not one of them can be acted on separately, so listing them
 * beside the app's own row only buries it. Updating the app updates all of
 * these, which is exactly why they are worth one line rather than six.
 */
export function bundledComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state === "bundled") ?? []
}

/** Everything else: the app, whatever is tracked, and anything wrong. */
export function trackedComponents(report: UpdateReport | null) {
  return report?.components.filter((entry) => entry.state !== "bundled") ?? []
}

/**
 * Every version as plain text, for pasting into a bug report.
 *
 * The bundled rows are in here even though the screen hides them: the moment
 * somebody is reporting a problem, "what exactly are you running" is the whole
 * question, and that is a different audience from someone glancing at whether
 * they need to update.
 */
export function versionReport(report: UpdateReport) {
  const lines = report.components.map((entry) => {
    const latest = entry.latest ? ` (latest ${entry.latest})` : ""

    return `${entry.name}: ${entry.current ?? "unknown"}${latest} [${entry.state}]`
  })

  return [
    `inferno-app version report - ${new Date(report.checkedAt).toISOString()}`,
    ...lines,
  ].join("\n")
}

// --- the stored result, and who is listening -------------------------------

const lastCheckStorageKey = "inferno-app.updates.last-check"
const changedEvent = "inferno-app:update-check-changed"

export type UpdateCheckState = {
  /** The last completed check, from any window, or null if there is none. */
  report: UpdateReport | null
  /** Whether one is running right now. */
  checking: boolean
}

let checking = false
let inflight: Promise<UpdateReport> | null = null

function announce() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(changedEvent))
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
 * One at a time, deliberately. The launch check and a click on "Check now" can
 * land together, and running both would double every request to answer one
 * question - against GitHub's unauthenticated rate limit that is a real cost.
 * Whoever asks second gets the answer the first is already waiting for.
 */
export function checkForUpdates(
  preferences: UpdatePreferences,
  options: { waitForService?: number } = {}
): Promise<UpdateReport> {
  if (inflight) {
    return inflight
  }

  checking = true
  announce()

  inflight = runUpdateCheck(preferences, options)
    .then((report) => {
      storeReport(report)

      return report
    })
    .finally(() => {
      inflight = null
      checking = false
      announce()
    })

  return inflight
}

/**
 * Subscribe to the last result, and to whether a check is running.
 *
 * The same shape as the settings store, for the same reason: the report lives
 * in `localStorage`, which is an external store, and reading it in an effect
 * would render once empty and again with the real thing.
 */
const idleState: UpdateCheckState = { report: null, checking: false }

let snapshotSource: string | null = null
let snapshotChecking = false
let snapshotValue: UpdateCheckState = idleState

function getSnapshot(): UpdateCheckState {
  const raw = window.localStorage.getItem(lastCheckStorageKey)

  // Rebuilt only when something it is made of moved - `getSnapshot` has to
  // return a stable reference, or React re-renders forever.
  if (raw !== snapshotSource || checking !== snapshotChecking) {
    snapshotSource = raw
    snapshotChecking = checking
    snapshotValue = { report: raw ? safeParse(raw) : null, checking }
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
