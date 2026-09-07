/**
 * Reads the version Tauri was built with. Mirrors `lib/tauri-window.ts`: the
 * same bundle is served by `npm run dev:web` in a plain browser, where the
 * Tauri API is absent, so this resolves to null instead of throwing.
 */
export async function getAppVersion(): Promise<string | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null
  }

  try {
    const { getVersion } = await import("@tauri-apps/api/app")

    return await getVersion()
  } catch {
    return null
  }
}
