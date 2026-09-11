"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { toast } from "sonner"

import { loadSettingsConfig } from "@/components/sections/settings/settings-config"
import { deliverToFolders, isSpotifyCompatible } from "@/lib/spotify"
import {
  deleteEntry,
  forgetEntry,
  listLibrary,
  primaryFile,
  recordDownload,
  type Deletion,
  type LibraryEntry,
} from "@/lib/inferno-library"
import {
  createTracker,
  ingestPostprocessor,
  ingestProgress,
  type JobTracker,
} from "@/lib/inferno-progress"
import {
  getServiceEndpoint,
  getServiceStatus,
  InfernoClient,
  pickDirectory,
  placeDownload,
  type DownloadRequest,
  type Health,
  type Job,
  type PostprocessorData,
  type ProgressData,
  type ServiceEndpoint,
  type ServiceErrorBody,
  type ServiceEvent,
  type VideoInfo,
} from "@/lib/inferno-service"

export type ConnectionState = "connecting" | "ready" | "offline"

type ServiceContextValue = {
  client: InfernoClient | null
  /** Capabilities and, usefully, the folder the service really writes to. */
  health: Health | null
  connection: ConnectionState
  /** Why the service is unavailable, when it is. */
  problem: string | null
  /** Live job trackers, newest first. */
  jobs: JobTracker[]
  /** The library's record for a job, once it has one. */
  entryFor: (jobId: string) => LibraryEntry | undefined
  /** Re-read the job list, for when a file changed outside the socket. */
  refreshJobs: () => Promise<void>
  /** Replace one entry after a verify or a relocate. */
  updateEntry: (entry: LibraryEntry) => void
  /** Everything the library remembers, newest first. */
  library: LibraryEntry[]
  /** Drop one entry from the library. The file itself is left alone. */
  forget: (entry: LibraryEntry) => Promise<void>
  /** Delete the file as well as the record. */
  destroy: (entry: LibraryEntry) => Promise<Deletion | null>
  /**
   * `toSpotify` is the download pane's switch, remembered against the job
   * until it finishes. It cannot travel on the request - the service knows
   * nothing about Spotify - and it cannot be re-read from settings later,
   * because the setting may have been changed mid-download.
   */
  queue: (
    request: DownloadRequest,
    toSpotify?: boolean,
    askWhereToSave?: boolean
  ) => Promise<Job>
  cancel: (jobId: string) => Promise<void>
  remove: (jobId: string, keepFiles?: boolean) => Promise<void>
  retry: (job: Job) => Promise<Job>
}

const ServiceContext = createContext<ServiceContextValue | null>(null)

/** Reconnect delay for the firehose. The service is local; be eager. */
const RECONNECT_DELAY = 1500

/**
 * Put a finished download where it was actually meant to go.
 *
 * The service writes into its own download folder and its request carries no
 * field for anywhere else, so every destination the app knows about is applied
 * here, after the fact: the save location, or a folder chosen on the spot when
 * the download was queued with "ask where to save" on.
 *
 * Runs before the Spotify delivery, so the copy Spotify gets is taken from
 * where the file has settled rather than from a path it is about to leave.
 *
 * Never rejects, for the same reason the Spotify one does not: the download
 * itself succeeded and still has to be recorded.
 */
async function deliverToDestination(job: Job, ask: boolean) {
  const file = primaryFile(job)
  if (!file?.path) {
    return
  }

  // Read here rather than closed over: this runs from the socket handler,
  // which is subscribed once for the life of the provider.
  const saved = loadSettingsConfig().downloads.location.trim()

  // Asked for at the moment it matters, which is now - the file exists, so a
  // folder chosen here is a folder something can actually be put in.
  const folder = ask ? await pickDirectory(saved || undefined) : saved

  // Nothing chosen and nothing configured: the service's own folder is where
  // it already is, and that is a real answer rather than a failure.
  if (!folder) {
    return
  }

  try {
    const landed = await placeDownload(file.path, folder)
    if (!landed) {
      return
    }

    // The job's path stops being true the moment it moves, and the library is
    // written from it a step later.
    file.path = landed
    file.name = landed.split(/[\/]/).pop() ?? file.name
  } catch (error) {
    toast.error("Could not move the download", {
      description:
        error instanceof Error
          ? error.message
          : "It is still in the download folder.",
    })
  }
}

/**
 * Copy or move a finished audio download into the chosen Spotify folder.
 *
 * Settings are read here rather than passed in: this runs from the socket
 * handler, which is subscribed once for the life of the provider, so anything
 * closed over would be whatever the settings happened to be when the app
 * started.
 *
 * Never rejects. A failure to deliver is worth telling someone about, but the
 * download itself succeeded and must still be recorded - so the error is shown
 * and the chain continues.
 */
async function deliverToSpotify(job: Job, wanted: boolean) {
  const spotify = loadSettingsConfig().spotify

  // The per-download switch decides; the setting is only its default. A job
  // queued with it off must not be delivered because the setting was on by the
  // time it finished.
  if (!wanted || spotify.folders.length === 0) {
    return
  }
  if (job.options?.mode !== "audio") {
    return
  }

  const file = primaryFile(job)
  if (!file?.path) {
    return
  }

  // The extension on disk is the only thing that is actually true. The
  // configure panel predicted this from the requested format, but a
  // postprocessor can be skipped - "already in target format" - so a job can
  // finish as something else entirely.
  if (!isSpotifyCompatible(file.path)) {
    toast.error("Not sent to Spotify", {
      description: `Spotify cannot play ${
        file.path.split(".").pop()?.toUpperCase() ?? "that"
      } local files.`,
    })

    return
  }

  const { delivered, skipped, failures, moved, finalPath } =
    await deliverToFolders(file.path, spotify.folders, spotify.keepOriginal)

  if (moved) {
    // The download is gone from where it was; point the job - and through it
    // the library - at where it actually is.
    file.path = finalPath
    // Either separator: the name can also have changed, since a clash may
    // have been kept alongside rather than replaced.
    file.name = finalPath.split(/[\\/]/).pop() ?? file.name
  }

  if (delivered === 0) {
    if (skipped > 0) {
      toast.info("Not added to Spotify", {
        description: "A file of that name was already there.",
      })

      return
    }
    toast.error("Could not add to Spotify", { description: failures[0] })

    return
  }

  toast.success("Added to Spotify", {
    description: `${
      delivered === 1
        ? "Copied into 1 folder"
        : `Copied into ${delivered} folders`
    }${moved ? ", and removed from your download folder." : "."}`,
  })
}

export function InfernoServiceProvider({ children }: { children: ReactNode }) {
  const [endpoint, setEndpoint] = useState<ServiceEndpoint | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [problem, setProblem] = useState<string | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  // Keyed by job so a queue row can find its record without a scan.
  const [entries, setEntries] = useState<Map<string, LibraryEntry>>(new Map())
  // Trackers accumulate across frames and are mutated in place, so the map
  // itself lives in a ref. What the tree renders from is a sorted snapshot
  // published out of the event handlers - never read from the ref during
  // render, which is unsound once React can restart one.
  const trackers = useRef(new Map<string, JobTracker>())
  const [jobs, setJobs] = useState<JobTracker[]>([])
  const lastSeq = useRef<number | null>(null)
  // Job id -> whether the download pane's Spotify switch was on when it was
  // queued. Entries are dropped as jobs finish, so this cannot grow.
  const spotifyWanted = useRef(new Map<string, boolean>())
  /** Jobs queued with "ask where to save" on, by id. */
  const askWanted = useRef(new Map<string, boolean>())

  const client = useMemo(
    () => (endpoint ? new InfernoClient(endpoint) : null),
    [endpoint]
  )

  /** Re-publish the snapshot. Safe to call as often as frames arrive. */
  const publish = useCallback(() => {
    setJobs(
      [...trackers.current.values()].sort(
        (a, b) => b.job.created_at - a.job.created_at
      )
    )
  }, [])

  const upsert = useCallback((job: Job) => {
    const existing = trackers.current.get(job.job_id)
    if (existing) {
      // Merge rather than replace: the tracker's accumulated stream and
      // postprocessor state is not in the REST payload.
      existing.job = { ...existing.job, ...job }
    } else {
      trackers.current.set(job.job_id, createTracker(job))
    }
  }, [])

  // The library outlives the service's in-memory jobs, so it is read once at
  // startup rather than derived from the event stream.
  useEffect(() => {
    let cancelled = false

    listLibrary()
      .then((rows) => {
        if (!cancelled && rows) {
          setEntries(new Map(rows.map((row) => [row.job_id, row])))
        }
      })
      .catch(() => {
        // No library this session; every row simply falls back to the job.
      })

    return () => {
      cancelled = true
    }
  }, [])

  const updateEntry = useCallback((entry: LibraryEntry) => {
    setEntries((current) => {
      const next = new Map(current)
      next.set(entry.job_id, entry)

      return next
    })
  }, [])

  const entryFor = useCallback((jobId: string) => entries.get(jobId), [entries])

  /**
   * Re-read the job list from the service.
   *
   * The socket reports what *happens to a job* - queued, progress, finished -
   * and nothing happens to a job when someone deletes the file it produced.
   * So the queue kept offering Open and Download for files that were gone:
   * `files[].exists` is computed by the service as it answers, and the client
   * was still holding the answer from when the job finished.
   *
   * Called where something is known to have changed on disk rather than on a
   * timer - the file browser after a delete, and a row's menu as it opens,
   * which is the moment its answer starts to matter.
   */
  const refreshJobs = useCallback(async () => {
    if (!client) {
      return
    }
    try {
      const listing = await client.listJobs()
      for (const job of listing.jobs) {
        upsert(job)
      }
      publish()
    } catch {
      // The socket remains the source of truth; a failed re-read just means
      // the list is as stale as it already was.
    }
  }, [client, upsert, publish])

  const forget = useCallback(async (entry: LibraryEntry) => {
    await forgetEntry(entry.id)
    setEntries((current) => {
      const next = new Map(current)
      next.delete(entry.job_id)

      return next
    })
  }, [])

  const destroy = useCallback(async (entry: LibraryEntry) => {
    const outcome = await deleteEntry(entry.id)
    setEntries((current) => {
      const next = new Map(current)
      next.delete(entry.job_id)

      return next
    })

    return outcome
  }, [])

  const library = useMemo(
    () =>
      [...entries.values()].sort((a, b) => b.downloaded_at - a.downloaded_at),
    [entries]
  )

  /**
   * Fill in a queued job's title and thumbnail while it downloads.
   *
   * The service only attaches `video` to a job once the download *finishes* -
   * it comes out of the same `extract_info` call that did the downloading - so
   * until then a row has nothing but its URL to show. Asking `/api/v1/info`
   * fills the gap, and it is nearly free: the configure panel has usually
   * already resolved that URL, and the service caches metadata, so this is
   * normally a cache hit rather than a second trip to YouTube.
   *
   * Once per job, whatever happens - a failure here just leaves the URL
   * showing, which is what it would have shown anyway.
   */
  const enriched = useRef(new Set<string>())

  /**
   * Whether this provider is still mounted.
   *
   * Deliberately *not* an effect-scoped flag. `publish` builds a new array on
   * every progress frame, so `jobs` changes identity many times a second while
   * anything is downloading - which re-runs the effect below and fires its
   * cleanup. A flag owned by one run would therefore be flipped almost
   * immediately, and the `info` response, arriving a second or two later, would
   * be discarded as stale. It never came back, because `enriched` had already
   * recorded the attempt: the row kept its URL for the whole download.
   *
   * The request only ever becomes genuinely uninteresting when the provider
   * goes away, so that is what this tracks. Reset on mount rather than only
   * cleared on unmount, so a Strict Mode remount does not leave it false.
   */
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!client) {
      return
    }

    const pending = jobs.filter(
      (tracker) =>
        !tracker.job.video &&
        tracker.job.url &&
        !enriched.current.has(tracker.job.job_id)
    )
    if (pending.length === 0) {
      return
    }

    for (const tracker of pending) {
      const { job_id: jobId, url } = tracker.job
      enriched.current.add(jobId)

      client
        .info(url)
        .then((info) => {
          const current = trackers.current.get(jobId)
          // The real thing may have landed first; never overwrite it.
          if (
            !mounted.current ||
            !info.video ||
            !current ||
            current.job.video
          ) {
            return
          }
          current.job.video = info.video
          publish()
        })
        .catch(() => {
          // The row keeps showing its URL, which is no worse than before.
        })
    }
  }, [client, jobs, publish])

  useEffect(() => {
    let cancelled = false

    const resolve = async () => {
      const found = await getServiceEndpoint()
      if (cancelled) {
        return
      }
      if (found) {
        setEndpoint(found)

        return
      }

      // No endpoint means startup failed. Rust kept the reason - including the
      // service's own stderr - so show that rather than a generic shrug.
      const status = await getServiceStatus()
      if (cancelled) {
        return
      }
      setConnection("offline")
      setProblem(
        status?.error ??
          "The download service is not running. Restart the app; if it keeps happening this installation is missing a component."
      )
    }

    void resolve()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!client) {
      return
    }

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    /**
     * The whole app runs on one socket, not one per job. Reconnects pass
     * `?since=` so nothing is missed; when the buffer had already dropped what
     * we asked for, the service says so and we refetch the list rather than
     * trusting a partial stream.
     *
     * `reset` is only set on that truncation path. The initial fetch races the
     * socket's `hello` frame, which carries the same list, so it merges rather
     * than clearing - otherwise whichever landed second would throw away the
     * other's work.
     */
    const sync = async (reset: boolean) => {
      try {
        const listing = await client.listJobs()
        if (reset) {
          trackers.current.clear()
        }
        for (const job of listing.jobs) {
          upsert(job)
        }
        publish()
      } catch {
        // The socket is the source of truth from here; a failed sync just
        // means the list fills in as events arrive.
      }
    }

    const connect = () => {
      if (disposed) {
        return
      }

      socket = new WebSocket(client.eventsUrl(lastSeq.current))

      socket.onopen = () => {
        setConnection("ready")
        setProblem(null)
      }

      socket.onclose = () => {
        if (disposed) {
          return
        }
        setConnection("connecting")
        retryTimer = setTimeout(connect, RECONNECT_DELAY)
      }

      socket.onmessage = (message) => {
        let frame: ServiceEvent
        try {
          frame = JSON.parse(message.data as string) as ServiceEvent
        } catch {
          return
        }

        lastSeq.current = frame.seq
        const data = frame.data ?? {}

        if (frame.type === "hello") {
          if (data.replay_truncated) {
            void sync(true)
          }
          for (const job of (data.jobs as Job[] | undefined) ?? []) {
            upsert(job)
          }
          publish()

          return
        }

        if (frame.type === "heartbeat" || frame.type === "pong") {
          return
        }
        if (!frame.job_id) {
          return
        }

        let tracker = trackers.current.get(frame.job_id)
        if (!tracker) {
          const seed = (data.job as Job | undefined) ?? {
            job_id: frame.job_id,
            url: "",
            status: "queued" as const,
            created_at: frame.ts,
          }
          tracker = createTracker(seed)
          trackers.current.set(frame.job_id, tracker)
        }

        if (frame.type === "job.queued" && data.job) {
          tracker.job = { ...tracker.job, ...(data.job as Job) }
        }

        if (frame.type.startsWith("job.")) {
          tracker.job.status =
            (data.status as Job["status"]) ?? tracker.job.status
        }

        if (frame.type === "job.extracting") {
          tracker.note = "reading metadata"
        }
        if (frame.type === "job.postprocessing") {
          tracker.note = "merging and embedding"
          tracker.speed = null
          tracker.eta = null
        }

        if (frame.type === "progress" || frame.type === "progress.finished") {
          const progress = data as ProgressData
          tracker.job.progress = progress
          ingestProgress(tracker, progress, frame.type === "progress.finished")
        }

        if (frame.type === "postprocessor") {
          ingestPostprocessor(tracker, data as PostprocessorData)
        }

        if (frame.type === "job.completed") {
          tracker.job.files = (data.files as Job["files"]) ?? []
          tracker.job.video = (data.video as VideoInfo) ?? tracker.job.video
          tracker.job.elapsed = data.elapsed as number

          // Deliver to Spotify *before* recording, not after. When the file
          // is moved rather than copied, the path the job carries stops being
          // true the moment it lands - so the library has to be told about the
          // new location, and it is only written once.
          const wanted = spotifyWanted.current.get(tracker.job.job_id) ?? false
          spotifyWanted.current.delete(tracker.job.job_id)
          const asked = askWanted.current.get(tracker.job.job_id) ?? false
          askWanted.current.delete(tracker.job.job_id)

          void deliverToDestination(tracker.job, asked)
            .then(() => deliverToSpotify(tracker.job, wanted))
            .then(() => recordDownload(tracker.job))
            .then((entry) => {
              if (entry) {
                updateEntry(entry)
              }
            })
            .catch((error: unknown) => {
              console.error("could not record the download", error)
            })
        }
        if (frame.type === "job.failed") {
          tracker.job.error = data.error as ServiceErrorBody
        }

        publish()
      }
    }

    // One shot: nothing in it changes without a restart or a settings patch,
    // and `settings.changed` would tell us if it did.
    client
      .health()
      .then(setHealth)
      .catch(() => setHealth(null))

    void sync(false)
    connect()

    return () => {
      disposed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      socket?.close()
    }
  }, [client, publish, upsert, updateEntry])

  const queue = useCallback(
    async (request: DownloadRequest, toSpotify = false, askWhereToSave = false) => {
      if (!client) {
        throw new Error("The download service is not running.")
      }
      const job = await client.queue(request)
      spotifyWanted.current.set(job.job_id, toSpotify)
      // Recorded at queue time, like the Spotify switch: what was asked for
      // when the download was set up, not what the settings say by the time
      // it finishes.
      askWanted.current.set(job.job_id, askWhereToSave)
      upsert(job)
      publish()

      return job
    },
    [client, upsert, publish]
  )

  const cancel = useCallback(
    async (jobId: string) => {
      if (!client) {
        return
      }
      const job = await client.cancel(jobId)
      upsert(job)
      publish()
    },
    [client, upsert, publish]
  )

  /**
   * Drop a job from the queue.
   *
   * `keepFiles` is what separates "remove" from "delete": the service deletes
   * everything the job produced when it is false - the media *and* its
   * sidecars, which the library does not track individually.
   */
  const remove = useCallback(
    async (jobId: string, keepFiles = true) => {
      if (!client) {
        return
      }
      await client.remove(jobId, keepFiles)
      trackers.current.delete(jobId)
      publish()
    },
    [client, publish]
  )

  /**
   * Re-queue with the options the job actually resolved to, so a retry after a
   * transient failure reproduces the original request rather than the app's
   * current panel state.
   */
  const retry = useCallback(
    async (job: Job) => {
      const requested = job.options?.requested as DownloadRequest | undefined

      return queue(requested ?? { url: job.url })
    },
    [queue]
  )

  const value = useMemo(
    () => ({
      client,
      health,
      entryFor,
      refreshJobs,
      updateEntry,
      library,
      forget,
      destroy,
      connection,
      problem,
      jobs,
      queue,
      cancel,
      remove,
      retry,
    }),
    [
      client,
      health,
      entryFor,
      refreshJobs,
      updateEntry,
      library,
      forget,
      destroy,
      connection,
      problem,
      jobs,
      queue,
      cancel,
      remove,
      retry,
    ]
  )

  return (
    <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>
  )
}

export function useInfernoService() {
  const value = useContext(ServiceContext)
  if (!value) {
    throw new Error(
      "useInfernoService must be used inside InfernoServiceProvider"
    )
  }

  return value
}
