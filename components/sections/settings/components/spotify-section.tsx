"use client"

import { useCallback, useEffect, useState } from "react"
import {
  RiAddLine,
  RiAlertLine,
  RiDeleteBinLine,
  RiFolderOpenLine,
  RiMusic2Line,
  RiRefreshLine,
  RiSpotifyLine,
} from "@remixicon/react"
import { toast } from "sonner"

import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { openPath } from "@/lib/inferno-service"
import { cn } from "@/lib/utils"
import {
  FOLDER_STATUS_TEXT,
  folderRows,
  pickSpotifyFolder,
  type FolderRow,
  type FolderStatus,
  surveySpotify,
  type SpotifySurvey,
} from "@/lib/spotify"

import { audioBitrateChoices } from "@/components/sections/downloads/download-options"

import { SpotifyTracksDialog } from "./spotify-tracks-dialog"

import type { SettingsSectionComponentProps } from "../settings-config"
import {
  SettingsFieldRow,
  SettingsPanel,
  SettingsSelectField,
  SettingsToggle,
} from "./settings-primitives"

/**
 * A colour per state, because the four are not degrees of the same thing.
 *
 * Green is working, red is broken, and the two in between are different kinds
 * of "not sure": blue for a folder you added that nobody has verified, amber
 * for one that used to work and has stopped. Reading them as a severity ramp
 * would be wrong - a manual folder is not half-broken, it is unconfirmed.
 *
 * The base badge is bare text, so each of these supplies its own padding and
 * tint. Both themes are stated: a bare `text-emerald-700` is unreadable on the
 * dark surface these sit on.
 */
const STATUS_BADGE: Record<FolderStatus, string> = {
  detected:
    "bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-400",
  manual:
    "bg-sky-500/10 px-1.5 py-0.5 text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-400",
  unwatched:
    "bg-amber-500/10 px-1.5 py-0.5 text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-400",
  unavailable:
    "bg-destructive/10 px-1.5 py-0.5 text-destructive ring-1 ring-destructive/25",
}

/**
 * A titled run of settings, with a rule to separate it from the last.
 *
 * `off` both dims the group and makes it `inert`, so a disabled section cannot
 * be tabbed into or clicked - dimming alone leaves a keyboard user walking
 * through controls that look unavailable and are not.
 *
 * The master switch deliberately sits outside every group. If it were inside
 * one, switching the extension off would make the thing that switches it back
 * on unreachable.
 */
function Group({
  title,
  off,
  children,
}: {
  title: string
  off?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      inert={off}
      className={cn(
        "flex flex-col gap-2 transition-opacity duration-200",
        off && "opacity-40"
      )}
    >
      <div className="flex items-center gap-3 pt-3">
        <span className="font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
          {title}
        </span>
        <Separator className="flex-1" />
      </div>
      {children}
    </section>
  )
}

export function SpotifySection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  const [survey, setSurvey] = useState<SpotifySurvey | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  /** Bumped to re-run the probe; the effect is the only thing that calls it. */
  const [attempt, setAttempt] = useState(0)
  /** The folder whose songs are being listed, if any. */
  const [viewing, setViewing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null)

  const spotify = config.spotify

  // A promise chain rather than an awaited async call: state is only ever
  // touched from a `.then`, so nothing is set on the way into the effect. An
  // effect that sets state synchronously renders twice for no reason.
  useEffect(() => {
    let live = true

    surveySpotify()
      .then((next) => {
        if (live) {
          setSurvey(next)
          setProblem(null)
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setProblem(
            error instanceof Error
              ? error.message
              : "Could not look for Spotify."
          )
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false)
        }
      })

    return () => {
      live = false
    }
  }, [attempt])

  /** Re-run the probe. The whole point is that the answer can change. */
  const probe = useCallback(() => {
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  const patch = useCallback(
    (next: Partial<typeof spotify>) => {
      updateConfig((current) => ({
        ...current,
        spotify: { ...current.spotify, ...next },
      }))
    },
    [updateConfig]
  )

  const installations = survey?.installations ?? []
  const installation =
    installations.find((entry) => entry.id === spotify.installation) ??
    (installations.length === 1 ? installations[0] : null)

  const accounts = installation?.accounts ?? []
  const account =
    accounts.find((entry) => entry.user_id === spotify.account) ??
    (accounts.length === 1 ? accounts[0] : null)

  const folders = account?.folders ?? []

  if (loading && !survey) {
    return (
      <SettingsPanel
        title="Spotify"
        description="Deliver finished audio into a Spotify local-files folder."
      >
        {/* The folder table, before it has folders. Same borders, same
            columns, so what arrives settles into the outline rather than
            replacing a spinner that looked nothing like it. */}
        <div className="border" aria-hidden>
          <div className="border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            Looking for Spotify…
          </div>
          {["w-72", "w-56", "w-64"].map((width, index) => (
            <div
              key={index}
              className="flex items-center justify-between gap-4 border-b px-3 py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className={cn("h-3 max-w-full", width)} />
                <Skeleton className="h-2 w-28" />
              </div>
              <Skeleton className="h-4 w-16 shrink-0" />
              <Skeleton className="h-5 w-9 shrink-0" />
            </div>
          ))}
        </div>
      </SettingsPanel>
    )
  }

  // --- nothing to configure yet -------------------------------------------
  //
  // Three different dead ends, and they need three different answers: Spotify
  // is not here, Spotify is here but has no folders, or the probe itself
  // failed. Collapsing them into one "not available" would leave the person
  // who only needs to flick a switch with nothing to act on.
  if (
    problem ||
    installations.length === 0 ||
    survey?.needs_local_files_enabled
  ) {
    return (
      <SettingsPanel
        title="Spotify"
        description="Deliver finished audio into a Spotify local-files folder."
      >
        <Empty className="border bg-muted/20 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiSpotifyLine />
            </EmptyMedia>
            <EmptyTitle>
              {problem
                ? "Could not check"
                : installations.length === 0
                  ? "Spotify not found"
                  : "No local-files folder yet"}
            </EmptyTitle>
            <EmptyDescription className="mx-auto max-w-sm">
              {problem ??
                (installations.length === 0
                  ? "No Spotify installation was found on this machine. Install Spotify and sign in, then check again."
                  : "In Spotify, open Settings, turn on “Show local files”, and add a source folder. Then restart Spotify — it only writes the list this reads on shutdown.")}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            size="sm"
            onClick={probe}
            disabled={loading}
          >
            {loading ? (
              <Spinner className="size-3.5" />
            ) : (
              <RiRefreshLine data-icon="inline-start" className="size-3.5" />
            )}
            Check again
          </Button>
        </Empty>
      </SettingsPanel>
    )
  }

  /** Show a folder in the file manager. */
  const openFolder = (path: string) => {
    void openPath(path).catch((error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : "Could not open that folder."
      )
    })
  }

  // Everything except the master switch is dimmed and unreachable while the
  // extension is off - there is nothing to configure about something that is
  // not running.
  const off = !spotify.enabled

  const chosen = new Set(spotify.folders)
  const ready = chosen.size > 0

  // One table, whatever a folder's situation is. A row that is delivering but
  // no longer detected has to stay visible, or the delivery becomes invisible.
  const rows = folderRows(folders, spotify.manualFolders, spotify.folders)

  // Removing a row means forgetting the path here - which only makes it
  // disappear if this app is the reason it is listed. A folder Spotify itself
  // reports would simply come back on the next probe, so offering "remove" for
  // one would be a button that appears to do nothing. Those are switched off
  // instead, which is the action that actually applies to them.
  const detectedPaths = new Set(folders.map((folder) => folder.path))

  const toggleFolder = (path: string, on: boolean) => {
    const next = new Set(chosen)
    if (on) {
      next.add(path)
    } else {
      next.delete(path)
    }

    // `enabled` is not touched here. Switching off the last folder used to
    // switch the whole extension off, which meant a moment of tidying up
    // silently undid a setting the user had turned on - and left them to work
    // out why. The extension stays on and says it has nowhere to deliver.
    patch({
      folders: [...next],
      installation: installation?.id ?? "",
      account: account?.user_id ?? "",
    })
  }

  const addFolder = async () => {
    try {
      const picked = await pickSpotifyFolder()
      if (!picked) {
        return
      }
      if (spotify.manualFolders.includes(picked) || chosen.has(picked)) {
        toast.info("Already in the list", { description: picked })

        return
      }

      // Added *and* switched on: picking a folder is the whole intent, and
      // making someone flick a switch straight afterwards is a step for its
      // own sake.
      patch({
        manualFolders: [...spotify.manualFolders, picked],
        folders: [...spotify.folders, picked],
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not add that folder."
      )
    }
  }

  /** Drop a folder from both lists, so the row goes away entirely. */
  const forgetFolder = (path: string) => {
    patch({
      manualFolders: spotify.manualFolders.filter((entry) => entry !== path),
      folders: spotify.folders.filter((entry) => entry !== path),
    })
  }

  /**
   * Confirm before removing.
   *
   * The row carries a switch that has been deliberately set, and possibly a
   * path someone typed in by hand; a stray click on a menu item should not
   * silently undo either. The wording says what is *not* happening, because
   * "remove" next to a folder full of music reads worse than it is.
   */
  const askToForget = (row: FolderRow) => {
    setConfirming({
      title: "Remove this folder from the list?",
      description: (
        <>
          Inferno will stop delivering downloads to it.{" "}
          {row.status === "manual"
            ? "You added this one by hand, so it will not come back on its own."
            : "Spotify is not reporting this folder, so it will not come back unless Spotify starts watching it again."}{" "}
          The folder and everything in it is left exactly as it is.
        </>
      ),
      confirmLabel: "Remove",
      destructive: true,
      run: () => forgetFolder(row.path),
    })
  }

  return (
    <SettingsPanel
      title="Spotify"
      description="Deliver finished audio into Spotify's local files. Spotify picks it up on its next scan."
    >
      <SettingsFieldRow
        label="Spotify extension"
        description={
          ready
            ? "Audio downloads are delivered to every folder switched on below."
            : "Nothing is delivered until a folder below is switched on."
        }
      >
        <SettingsToggle
          label="Spotify extension"
          checked={spotify.enabled}
          onCheckedChange={(enabled) => patch({ enabled })}
        />
      </SettingsFieldRow>

      {/* On with nowhere to go is a real state, not one to prevent: it is what
          you are in halfway through setting this up. Saying so beats refusing
          the switch and leaving someone to guess why it will not move. */}
      {spotify.enabled && !ready ? (
        <div className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
          <RiAlertLine className="mt-px size-3 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
            No folder is switched on, so nothing will be delivered yet.
          </p>
        </div>
      ) : null}

      <Group title="Where downloads go" off={off}>
        {installations.length > 1 ? (
          <SettingsFieldRow
            label="Installation"
            description="More than one Spotify is installed on this machine."
          >
            <SettingsSelectField
              value={installation?.id ?? ""}
              onValueChange={(id) =>
                // A different install has different folders, so the chosen
                // ones cannot carry over - but the extension itself stays on.
                patch({ installation: id, account: "", folders: [] })
              }
              options={installations.map((entry) => ({
                label: entry.label,
                value: entry.id,
              }))}
            />
          </SettingsFieldRow>
        ) : null}

        {accounts.length > 1 ? (
          <SettingsFieldRow
            label="Account"
            description="This installation has signed in more than one account."
          >
            <SettingsSelectField
              value={account?.user_id ?? ""}
              onValueChange={(id) => patch({ account: id, folders: [] })}
              options={accounts.map((entry) => ({
                label: entry.user_id,
                value: entry.user_id,
              }))}
            />
          </SettingsFieldRow>
        ) : null}

        {/* A table rather than a picker: Spotify allows several source folders,
          and which of them a download belongs in is not an either/or. */}
        <div className="mt-2 border">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b bg-muted/30 px-3 py-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            <span>Folder</span>
            <span>Status</span>
            <span className="sr-only">Enabled</span>
          </div>

          {rows.map((row) => {
            const meaning = FOLDER_STATUS_TEXT[row.status]

            return (
              <ContextMenu key={row.path}>
                <ContextMenuTrigger
                  render={
                    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b px-3 py-2.5 last:border-b-0" />
                  }
                >
                  <div className="min-w-0">
                    {/* The path is the link. `dir="rtl"` truncates it from the
                      left, keeping the end of the tree visible - the part that
                      actually tells two folders apart - and `text-left` puts
                      the line back where it belongs. The icon sits outside
                      that span, or the reversed direction would park it on the
                      wrong end. */}
                    <button
                      type="button"
                      onClick={() => openFolder(row.path)}
                      title={"Open " + row.path}
                      className="group/path flex w-full min-w-0 items-center gap-1.5 text-left transition-colors hover:text-foreground"
                    >
                      <span
                        dir="rtl"
                        className="min-w-0 truncate text-left font-mono text-[12px] font-medium underline decoration-transparent underline-offset-2 transition-colors group-hover/path:decoration-current"
                      >
                        {row.path}
                      </span>
                      <RiFolderOpenLine className="size-3 shrink-0 text-muted-foreground transition-colors group-hover/path:text-foreground" />
                    </button>

                    {row.status === "detected" ? (
                      <button
                        type="button"
                        onClick={() => setViewing(row.path)}
                        className="mt-0.5 text-[10px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                      >
                        View {row.audioFiles}{" "}
                        {row.audioFiles === 1 ? "song" : "songs"}
                      </button>
                    ) : (
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                        {meaning.detail}
                      </p>
                    )}
                  </div>

                  <Badge
                    className={STATUS_BADGE[row.status]}
                    title={meaning.detail}
                  >
                    {meaning.label}
                  </Badge>

                  {/* An unavailable folder cannot be switched *on*, but one
                    that is already on has to be switchable off - otherwise a
                    drive going missing would leave a delivery target nobody
                    could turn off. */}
                  <SettingsToggle
                    label={"Send downloads to " + row.path}
                    checked={row.enabled}
                    disabled={row.status === "unavailable" && !row.enabled}
                    onCheckedChange={(on) => toggleFolder(row.path, on)}
                  />
                </ContextMenuTrigger>

                <ContextMenuContent>
                  <ContextMenuItem onClick={() => openFolder(row.path)}>
                    <RiFolderOpenLine />
                    Open file location
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={row.status !== "detected"}
                    onClick={() => setViewing(row.path)}
                  >
                    <RiMusic2Line />
                    View songs
                  </ContextMenuItem>
                  {detectedPaths.has(row.path) ? null : (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => askToForget(row)}
                      >
                        <RiDeleteBinLine />
                        Remove from list
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>

        {/* Adding by hand exists because the probe reads what Spotify wrote on
          its last shutdown - a folder added in Spotify a minute ago is simply
          not there yet. */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] leading-snug text-muted-foreground">
            Not listed? Spotify only writes its folder list when it closes, so a
            folder added just now may not appear until you restart it.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void addFolder()}
            className="shrink-0"
          >
            <RiAddLine data-icon="inline-start" className="size-3.5" />
            Add folder
          </Button>
        </div>
      </Group>

      <Group title="How they are delivered" off={off}>
        <SettingsFieldRow
          label="Switch on by default"
          description="Start each download with “Add to Spotify” already on."
        >
          {/* Not gated on having a folder either: this is a preference about
              future downloads, and refusing to record it because nothing is
              switched on right now would be the same trap as before. */}
          <SettingsToggle
            label="Switch on by default"
            checked={spotify.defaultOn}
            onCheckedChange={(defaultOn) => patch({ defaultOn })}
          />
        </SettingsFieldRow>

        {/* What the command menu's one-step version does. It never shows
            the download pane, so what the pane would have asked about is
            answered here instead - the bitrate, and only the bitrate: the
            format is always MP3 because nothing else this app makes can be
            played from a local-files folder. */}
        <SettingsFieldRow
          label="Command menu quality"
          description="Bitrate for “Add to Spotify”, which always downloads MP3. Local files are kept, so the top step is the default."
        >
          <SettingsSelectField
            value={String(spotify.quickBitrateKbps)}
            onValueChange={(value) =>
              patch({ quickBitrateKbps: Number(value) })
            }
            options={audioBitrateChoices.map((choice) => ({
              label: choice.label,
              value: choice.value,
            }))}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          label="Keep the original download"
          description={
            spotify.keepOriginal
              ? "Saved to your download folder and copied into Spotify."
              : chosen.size > 1
                ? "Copied — with more than one folder on, the download has to stay put."
                : "Moved into Spotify — it will not be kept in your download folder."
          }
        >
          <SettingsToggle
            label="Keep the original download"
            checked={spotify.keepOriginal}
            onCheckedChange={(keepOriginal) => patch({ keepOriginal })}
          />
        </SettingsFieldRow>

        {/* Only for the combination that does this without being asked each
            time. With the switch off by default the download pane says the
            same thing at the moment someone turns it on, and a standing
            warning here about a choice nobody has made yet is just something
            to look past - which is how warnings stop being read. */}
        {!off &&
        spotify.defaultOn &&
        !spotify.keepOriginal &&
        chosen.size === 1 ? (
          <div className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
            <RiAlertLine className="mt-px size-3 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-400">
              Every audio download will be moved into your local-files folder
              and left nowhere else — none of them will be in your download
              folder afterwards.
            </p>
          </div>
        ) : null}
      </Group>

      <ConfirmDialog
        request={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
          }
        }}
      />

      <SpotifyTracksDialog
        folder={viewing}
        onOpenChange={(open) => {
          if (!open) {
            setViewing(null)
          }
        }}
      />

      <div className="flex justify-end pt-2">
        <Button variant="outline" size="sm" onClick={probe} disabled={loading}>
          {loading ? (
            <Spinner className="size-3.5" />
          ) : (
            <RiRefreshLine data-icon="inline-start" className="size-3.5" />
          )}
          Re-check Spotify
        </Button>
      </div>
    </SettingsPanel>
  )
}
