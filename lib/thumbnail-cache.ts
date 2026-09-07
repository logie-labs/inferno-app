"use client"

/**
 * Keeping row artwork after the first time it is fetched.
 *
 * The queue draws the same handful of thumbnails every time it is opened, and
 * every one of them was a request to a CDN - so the list rebuilt itself out of
 * the network on each visit, showed grey boxes for a beat, and had nothing at
 * all to show offline.
 *
 * IndexedDB rather than the Rust side, because the images are already reachable
 * from the webview: the thumbnail hosts send `Access-Control-Allow-Origin: *`,
 * so the bytes can be read here without a HTTP client in the app, a command to
 * carry them across, or a base64 round trip to survive the crossing. Blobs are
 * stored as blobs, which is the other reason not to route this through IPC.
 *
 * Every failure path resolves to `null` rather than throwing. This is a cache:
 * not having it should cost a network request, never a broken row.
 */

import { useEffect, useState } from "react"

const DATABASE = "inferno-app.thumbnails"
const STORE = "images"
const BY_AGE = "cachedAt"

/** Past this many entries the oldest are dropped, back down to `KEEP`. */
const MAX = 800
const KEEP = 600

type Entry = { url: string; blob: Blob; cachedAt: number }

let opening: Promise<IDBDatabase | null> | null = null

/** One connection for the app's lifetime; the promise is the lock. */
function database() {
  if (opening) {
    return opening
  }

  opening = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null)
      return
    }

    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE, 1)
    } catch {
      // Storage can be refused outright rather than merely failing.
      resolve(null)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "url" })
        store.createIndex(BY_AGE, "cachedAt")
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

  return opening
}

function store(db: IDBDatabase, mode: IDBTransactionMode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

function settle<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

/**
 * Trim the cache, once per run.
 *
 * By age rather than by use: a thumbnail is only ever wanted for a row that
 * still exists, and the rows that leave the queue are the old ones.
 */
let trimmed = false

async function trim(db: IDBDatabase) {
  if (trimmed) {
    return
  }
  trimmed = true

  const count = await settle(store(db, "readonly").count())
  if (!count || count <= MAX) {
    return
  }

  let remaining = count - KEEP
  const cursor = store(db, "readwrite").index(BY_AGE).openCursor()

  cursor.onsuccess = () => {
    const at = cursor.result
    if (!at || remaining <= 0) {
      return
    }

    at.delete()
    remaining -= 1
    at.continue()
  }
}

async function read(url: string) {
  const db = await database()
  if (!db) {
    return null
  }

  const entry = await settle(store(db, "readonly").get(url) as IDBRequest<Entry>)

  return entry?.blob ?? null
}

async function write(url: string, blob: Blob) {
  const db = await database()
  if (!db) {
    return
  }

  store(db, "readwrite").put({ url, blob, cachedAt: Date.now() } satisfies Entry)
  void trim(db)
}

/** The stored copy, or the network once - after which there is a stored copy. */
async function resolve(url: string) {
  const cached = await read(url)
  if (cached) {
    return cached
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }

    const blob = await response.blob()
    void write(url, blob)

    return blob
  } catch {
    return null
  }
}

/**
 * The cached artwork for a URL, as something an `img` can use.
 *
 * Null until there is one, so a caller falls back to the remote URL and the
 * first visit still draws immediately rather than waiting on this. The answer
 * is kept against the URL it belongs to: when the row changes, the old object
 * URL is revoked, and returning it for even one render would paint a picture
 * the browser has already been told to forget.
 */
export function useCachedThumbnail(url: string | null) {
  const [entry, setEntry] = useState<{ url: string; src: string } | null>(null)

  useEffect(() => {
    if (!url) {
      return
    }

    let live = true
    let objectUrl: string | null = null

    void resolve(url).then((blob) => {
      if (!live || !blob) {
        return
      }

      objectUrl = URL.createObjectURL(blob)
      setEntry({ url, src: objectUrl })
    })

    return () => {
      live = false
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [url])

  return entry?.url === url ? entry.src : null
}
