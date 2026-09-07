"use client"

import { useState } from "react"
import {
  RiDownload2Line,
  RiUpload2Line,
} from "@remixicon/react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { exportSettings, importSettings } from "@/lib/settings-transfer"

import type { SettingsSectionComponentProps } from "../settings-config"
import { SettingsFieldRow, SettingsPanel } from "./settings-primitives"

/** The last segment of a path - enough to say which file it was. */
function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

export function BackupSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  const [busy, setBusy] = useState<"export" | "import" | null>(null)

  const runExport = async () => {
    setBusy("export")
    try {
      const path = await exportSettings(config)
      // Null means the save dialog was dismissed, which is not a failure and
      // should not be announced as one.
      if (path) {
        toast.success("Settings exported", { description: baseName(path) })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not export settings."
      )
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    setBusy("import")
    try {
      const result = await importSettings()
      if (!result) {
        return
      }

      // Replaces wholesale rather than merging into what is on screen: a
      // half-applied import is the one outcome nobody could reason about. The
      // file has already been through the store's own merge, so anything it
      // omits is a default rather than a hole.
      updateConfig(() => result.settings)
      toast.success("Settings imported", {
        description: result.path
          ? `From ${baseName(result.path)}`
          : "Applied to this device.",
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not import settings."
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPanel
      title="Backup"
      description="Move your settings between machines, or keep a copy before changing something."
    >
      <SettingsFieldRow
        label="Export settings"
        description="Writes every setting on this screen, including your shortcuts, to a JSON file."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runExport()}
          disabled={busy !== null}
        >
          {busy === "export" ? (
            <Spinner className="size-3.5" />
          ) : (
            <RiDownload2Line data-icon="inline-start" className="size-3.5" />
          )}
          Export
        </Button>
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Import settings"
        description="Replaces everything on this screen. Anything the file does not mention goes back to its default."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void runImport()}
          disabled={busy !== null}
        >
          {busy === "import" ? (
            <Spinner className="size-3.5" />
          ) : (
            <RiUpload2Line data-icon="inline-start" className="size-3.5" />
          )}
          Import
        </Button>
      </SettingsFieldRow>
    </SettingsPanel>
  )
}
