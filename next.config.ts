import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "export",
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  experimental: {
    /**
     * Turbopack's persistent dev cache, off.
     *
     * It defaults to on in Next 16, and it is what makes a long-running
     * `dev:tauri` session die: the store under `.next/dev/cache` grows without
     * bound - it was 649 MB after an hour here - and the index it keeps in the
     * JS heap grows with it. Watched while completely idle, the dev server
     * climbed roughly 15 MB a second and reached V8's ~16 GB ceiling in a
     * little under an hour, which is exactly when the crashes happened.
     *
     * The cost is a slower cold start, since nothing survives a restart. That
     * is a fair trade for a dev server that does not have to be restarted
     * every hour, and it changes nothing about production builds.
     */
    turbopackFileSystemCacheForDev: false,
  },
}

export default nextConfig
