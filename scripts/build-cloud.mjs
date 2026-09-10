/**
 * `next build` with the container's build flag set.
 *
 * The flag has to be in the environment *of the build*, and there is no way to
 * write `VAR=value next build` in a package.json script that works on both
 * Windows and Linux - `cmd.exe` reads it as a command, not an assignment. The
 * usual answer is a `cross-env` dependency; this is the same thing in fifteen
 * lines and no supply chain.
 *
 * The Docker build does not run this. It sets `ENV NEXT_PUBLIC_INFERNO_TARGET`
 * in the Dockerfile and calls `npm run build` directly, because a layer that
 * declares its own environment is easier to read than one that hides it in a
 * script. This exists so the container's frontend can be built and inspected
 * on the host - `npm run build:cloud && npx serve out` - without Docker in the
 * way.
 *
 * Output lands in `out/`, the same place `npm run build` writes. The two builds
 * overwrite each other: run `npm run build` before packaging the desktop app if
 * this ran last.
 */

import { spawnSync } from "node:child_process"

const result = spawnSync("next", ["build"], {
  stdio: "inherit",
  // Windows resolves `next` to `next.cmd`, which is not executable without a
  // shell. On Linux the shell is harmless - the arguments are fixed here, so
  // there is nothing for it to expand.
  shell: true,
  env: { ...process.env, NEXT_PUBLIC_INFERNO_TARGET: "cloud" },
})

if (result.error) {
  console.error(`build:cloud: could not start next - ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
