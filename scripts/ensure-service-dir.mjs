/**
 * Creates an empty `service/dist/inferno-service/` when there is not one.
 *
 * `tauri.conf.json` declares that directory as a bundle resource, and
 * tauri-build fails the whole compile if a declared resource is missing - so
 * without this, a fresh clone cannot even run `npm run dev:tauri` until it has
 * sat through a PyInstaller build it does not need. In a debug build the Rust
 * side falls back to running the service straight out of `service/.venv`
 * (see addons/inferno_service/process.rs), so an empty directory here is
 * exactly right: it satisfies the resource declaration and resolves to no
 * bundled executable, which is what sends the lookup to the venv.
 *
 * `npm run build:service` overwrites it with the real thing.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "service", "dist", "inferno-service")

if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true })
  writeFileSync(
    join(dist, "README.txt"),
    "Placeholder so Tauri's resource declaration resolves during development.\n" +
      "Run `npm run build:service` to put the real packaged service here.\n"
  )
  console.log(`ensure-service-dir: created ${dist}`)
}
