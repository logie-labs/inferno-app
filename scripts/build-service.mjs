/**
 * Builds `inferno-service` into `service/dist/inferno-service/` so Tauri can
 * ship it as a bundle resource, and refuses to produce a broken installer.
 *
 * Three things go wrong quietly if nobody checks, and all of them only show up
 * on a clean install rather than on the machine that built it:
 *
 *   1. The vendored binaries are gitignored (large, platform-specific), so a
 *      fresh clone has an empty `vendor/`. The bundle would build fine and then
 *      fail every merge at runtime with `ffmpeg_missing`.
 *   2. On a conda-based interpreter, CPython's extension modules load their
 *      real DLLs (`ffi.dll`, `libbz2.dll`, `sqlite3.dll`) from
 *      `<base_prefix>/Library/bin`, which PyInstaller does not search. It warns
 *      and carries on, and the frozen exe then dies on `import ctypes`.
 *   3. PyInstaller can miss a dynamically-imported module and still exit 0.
 *
 * So the build verifies twice: `--check` resolves the binaries, and then the
 * exe is actually started and polled on `/health`. The second one matters -
 * `--check` never imports uvicorn, so it happily passes on a build that cannot
 * serve a single request.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const service = join(root, "service")
const dist = join(service, "dist", "inferno-service")

const windows = process.platform === "win32"
const venvPython = windows
  ? join(service, ".venv", "Scripts", "python.exe")
  : join(service, ".venv", "bin", "python")

/** Everything that must exist before a bundle is worth building. */
const vendored = [
  join(service, "vendor", "ffmpeg", windows ? "ffmpeg.exe" : "ffmpeg"),
  join(service, "vendor", "ffmpeg", windows ? "ffprobe.exe" : "ffprobe"),
  join(service, "vendor", "js", windows ? "qjs.exe" : "qjs"),
]

const vendorEnv = {
  FFMPEG_DIR: join(service, "vendor", "ffmpeg"),
  JS_RUNTIME_DIR: join(service, "vendor", "js"),
}

function fail(message) {
  console.error(`\n  build-service: ${message}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: service,
    ...options,
  })
  if (result.error) {
    fail(`${command} could not be run (${result.error.message})`)
  }
  if (result.status !== 0) {
    fail(`${command} exited with ${result.status}`)
  }
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

if (!existsSync(venvPython)) {
  fail(
    `no virtualenv at ${venvPython}.\n` +
      `  Create one and install the service:\n` +
      `    python -m venv service/.venv\n` +
      `    service/.venv/Scripts/pip install -e "service[dev]" pyinstaller`
  )
}

const missing = vendored.filter((path) => !existsSync(path))
if (missing.length > 0) {
  fail(
    `the vendored binaries are missing:\n` +
      missing.map((path) => `    ${path}`).join("\n") +
      `\n  They are gitignored because they are large and platform-specific.\n` +
      `  See service/vendor/README.md for where to put them. Without them the\n` +
      `  installer builds but every merge fails at runtime.`
  )
}

/**
 * PyInstaller finds a DLL dependency by walking PATH. A conda interpreter keeps
 * the ones CPython's own extension modules need in `Library/bin`, which is not
 * on PATH unless the environment is "activated", so add it explicitly.
 */
function buildEnv() {
  const probe = spawnSync(venvPython, ["-c", "import sys; print(sys.base_prefix)"], {
    encoding: "utf8",
  })
  const basePrefix = (probe.stdout ?? "").trim()
  const extra = [
    join(basePrefix, "Library", "bin"),
    join(basePrefix, "Library", "mingw-w64", "bin"),
    join(basePrefix, "DLLs"),
  ].filter((path) => path && existsSync(path))

  if (extra.length > 0) {
    console.log(`build-service: adding to the DLL search path:`)
    for (const path of extra) {
      console.log(`    ${path}`)
    }
  }

  return {
    ...process.env,
    PATH: [...extra, process.env.PATH].join(windows ? ";" : ":"),
  }
}

// A stale tree would silently ship yesterday's code alongside today's.
rmSync(dist, { recursive: true, force: true })

console.log("build-service: packaging with PyInstaller…")
run(
  venvPython,
  [
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--distpath",
    join(service, "dist"),
    "--workpath",
    join(service, "build"),
    join(service, "inferno-service.spec"),
  ],
  { env: buildEnv() }
)

const built = join(dist, windows ? "inferno-service.exe" : "inferno-service")
if (!existsSync(built)) {
  fail(`PyInstaller reported success but ${built} does not exist`)
}

// First check: do the three binaries resolve? `--check` exits non-zero if not.
console.log("build-service: verifying resolved binaries…")
run(built, ["--check"], { env: { ...process.env, ...vendorEnv } })

/**
 * Second check, and the one that catches a broken freeze: start the thing and
 * ask it for `/health` the way the app does. A missing hidden import or an
 * unresolved DLL only surfaces once uvicorn and yt-dlp are actually imported,
 * which `--check` never does.
 */
async function verifyItServes() {
  console.log("build-service: verifying the service actually serves…")

  const port = 8000 + Math.floor(Math.random() * 1000)
  const token = "build-check"
  const child = spawn(built, ["--host", "127.0.0.1", "--port", String(port)], {
    cwd: service,
    env: {
      ...process.env,
      ...vendorEnv,
      API_TOKEN: token,
      INFERNO_CONFIG_FILE: join(service, "dist", ".build-check-settings.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))

  let exited = null
  child.on("exit", (code) => (exited = code))

  const deadline = Date.now() + 60_000
  try {
    while (Date.now() < deadline) {
      if (exited !== null) {
        fail(
          `the built service exited with ${exited} instead of serving.\n` +
            output.split("\n").slice(-25).join("\n")
        )
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { "X-API-Key": token },
        })
        if (response.ok) {
          const health = await response.json()
          console.log(
            `build-service: serving - yt-dlp ${health.yt_dlp_version}, ` +
              `ffmpeg ${health.ffmpeg.source}, js ${health.js_runtime.source}`
          )

          return
        }
        fail(`/health answered ${response.status}; expected 200`)
      } catch {
        // Not listening yet.
      }

      await delay(250)
    }

    fail(
      `the built service never answered /health.\n` +
        output.split("\n").slice(-25).join("\n")
    )
  } finally {
    // Wait for it to be gone, not merely signalled. On Windows the exe stays
    // locked for a moment after `kill()`, and the next thing to touch the
    // build tree - a `cargo` run, another build - fails with EBUSY.
    child.kill()
    if (exited === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5000)
        child.once("exit", () => {
          clearTimeout(timer)
          done()
        })
      })
    }
  }
}

await verifyItServes()

console.log(`build-service: ok -> ${dist}`)
