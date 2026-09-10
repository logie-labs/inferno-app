/**
 * Which build this is: the Tauri desktop app, or the container.
 *
 * One flag, read once, exported as a constant. `NEXT_PUBLIC_*` is inlined by
 * Next at build time rather than read at runtime, so `isCloud` is a literal
 * `false` in the desktop bundle and the container-only branches are statically
 * dead. That is the point: the desktop app has to render and behave exactly as
 * it did before this file existed. Deciding at runtime would not be good
 * enough - a browser check can be wrong, and `dev:web` would trip it.
 *
 * Whether the minifier also *deletes* the dead branch depends on how far it
 * will fold a property read on `capabilities` across a module boundary, so do
 * not read this as a promise of identical bytes. The guarantee is behavioural,
 * and worth confirming the same way anything else is:
 *
 * ```bash
 * npm run build   # desktop output, unchanged
 * ```
 *
 * Read this instead of sniffing for Tauri when the question is *which product
 * is this*. `inTauri()` in `lib/inferno-service.ts` answers a different
 * question - *is the IPC bridge present right now* - and the two come apart in
 * `npm run dev:web`, which is the desktop build running in a plain browser.
 */

export type DeploymentTarget = "local" | "cloud"

/**
 * Anything other than an explicit "cloud" is the desktop app.
 *
 * Defaulting to `local` on an unset or misspelt value is deliberate: a typo in
 * a Docker build arg should produce a container that is obviously wrong (window
 * controls in a browser tab), not a desktop app quietly missing its title bar.
 */
export const DEPLOYMENT_TARGET: DeploymentTarget =
  process.env.NEXT_PUBLIC_INFERNO_TARGET === "cloud" ? "cloud" : "local"

export const isCloud = DEPLOYMENT_TARGET === "cloud"
export const isLocal = !isCloud

/**
 * What this build can actually do, named by capability rather than by target.
 *
 * Call sites read better for it - `capabilities.windowControls` says why the
 * buttons are gone, where `!isCloud` only says where we are - and it gives the
 * features that drop in a container exactly one place to be listed.
 *
 * Everything false here is false because a Linux container has no desktop
 * session to talk to, not because it was cut for time.
 */
export const capabilities = {
  /** Minimise / maximise / close. There is no OS window around a browser tab. */
  windowControls: isLocal,
  /** Taskbar and dock progress. Same reason. */
  taskbarProgress: isLocal,
  /** "Open folder" / "Reveal in explorer" - no user filesystem to reveal into. */
  revealInFileManager: isLocal,
  /** The native directory picker, and the local paths it returns. */
  localFilesystem: isLocal,
  /** Soundpad's remote control - a Windows desktop application. */
  soundpad: isLocal,
  /** Scanning the local Spotify install for offline tracks. */
  spotifyLocalScan: isLocal,
  /** Updating the app itself. A container is replaced by pulling a new image. */
  appUpdates: isLocal,
} as const
