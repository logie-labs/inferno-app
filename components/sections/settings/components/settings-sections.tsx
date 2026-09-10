"use client"

import { useEffect, useState } from "react"

import { RiDownloadLine, RiGlobalLine } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { TokenInput } from "@/components/ui/token-input"

import { SaveLocations } from "./save-locations"
import { getAppVersion } from "@/lib/app-version"
import { CASE_STYLES, previewTemplate, TOKENS } from "@/lib/filename-template"

import type {
  SettingsConfig,
  SettingsSectionComponentProps,
} from "../settings-config"
import {
  SettingsFieldRow,
  SettingsPanel,
  SettingsSelectField,
  SettingsSliderField,
  SettingsTextField,
  SettingsToggle,
} from "./settings-primitives"

export function AppearanceSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Appearance"
      description="Keep the visual language consistent across the app."
    >
      <SettingsFieldRow label="Theme" description="Pick the global color mode.">
        <SettingsSelectField
          value={config.appearance.theme}
          onValueChange={(theme) =>
            updateConfig((current) => ({
              ...current,
              appearance: {
                ...current.appearance,
                theme: theme as SettingsConfig["appearance"]["theme"],
              },
            }))
          }
          options={[
            { label: "System", value: "system" },
            { label: "Light", value: "light" },
            { label: "Dark", value: "dark" },
          ]}
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Animate theme changes"
        description="Cross-fade the whole window when the theme switches."
      >
        <SettingsToggle
          label="Animate theme changes"
          checked={config.appearance.themeAnimation}
          onCheckedChange={(themeAnimation) =>
            updateConfig((current) => ({
              ...current,
              appearance: { ...current.appearance, themeAnimation },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function DownloadsSettingsSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Downloads"
      description="Where finished files land and how many run at once."
    >
      {/* Its own block rather than a `SettingsFieldRow`: a list needs the full
          width, and the answer under each row wrapped after three words when
          this was a single field in a row's right-hand column. */}
      <div className="flex flex-col gap-2">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Save locations</div>
          <p className="text-xs text-muted-foreground">
            Where finished downloads are moved once they are complete. Keep as
            many folders as you like and pick the one in use.
          </p>
        </div>
        <SaveLocations config={config} updateConfig={updateConfig} />
      </div>

      <SettingsFieldRow
        label="Concurrent downloads"
        description="How many transfers may run in parallel."
      >
        <SettingsSliderField
          value={config.downloads.concurrentDownloads}
          min={1}
          max={10}
          step={1}
          onValueChange={(concurrentDownloads) =>
            updateConfig((current) => ({
              ...current,
              downloads: { ...current.downloads, concurrentDownloads },
            }))
          }
        />
      </SettingsFieldRow>

      <div className="flex flex-col gap-3 border bg-muted/20 p-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Filename template</div>
          <p className="text-xs text-muted-foreground">
            Type a token between {"{ "} and {"}"} to pick a token, or click one
            below. Everything else is used literally.
          </p>
        </div>

        <TokenInput
          value={config.downloads.filenameTemplate}
          onValueChange={(filenameTemplate) =>
            updateConfig((current) => ({
              ...current,
              downloads: { ...current.downloads, filenameTemplate },
            }))
          }
          tokens={TOKENS}
          // The fallback itself, so an emptied field shows what it will
          // actually be called rather than an instruction.
          placeholder="Title"
          suffix=".ext"
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase">
              Preview
            </div>
            <div className="truncate font-mono text-xs">
              {previewTemplate(
                config.downloads.filenameTemplate,
                config.downloads.filenameCase
              )}
              <span className="text-muted-foreground">.mp4</span>
            </div>
          </div>

          <SettingsSelectField
            value={config.downloads.filenameCase}
            onValueChange={(filenameCase) =>
              updateConfig((current) => ({
                ...current,
                downloads: {
                  ...current.downloads,
                  filenameCase:
                    filenameCase as SettingsConfig["downloads"]["filenameCase"],
                },
              }))
            }
            options={CASE_STYLES.map((style) => ({
              label: style.label,
              value: style.value,
            }))}
          />
        </div>
      </div>

      <SettingsFieldRow
        label="Ask where to save"
        description="Choose a folder as each download finishes, the way a browser can. The save location above is the starting point for that question."
      >
        <SettingsToggle
          label="Ask where to save"
          checked={config.downloads.askWhereToSave}
          onCheckedChange={(askWhereToSave) =>
            updateConfig((current) => ({
              ...current,
              downloads: { ...current.downloads, askWhereToSave },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Start queued items automatically"
        description="Begin downloading as soon as a link is added."
      >
        <SettingsToggle
          label="Start queued items automatically"
          checked={config.downloads.autoStartQueued}
          onCheckedChange={(autoStartQueued) =>
            updateConfig((current) => ({
              ...current,
              downloads: { ...current.downloads, autoStartQueued },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function StartupSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Startup"
      description="What happens when the app launches."
    >
      <SettingsFieldRow
        label="Launch on startup"
        description="Open the app when you sign in to Windows."
      >
        <SettingsToggle
          label="Launch on startup"
          checked={config.startup.launchOnStartup}
          onCheckedChange={(launchOnStartup) =>
            updateConfig((current) => ({
              ...current,
              startup: { ...current.startup, launchOnStartup },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Reopen last section"
        description="Restore the section you were last using."
      >
        <SettingsToggle
          label="Reopen last section"
          checked={config.startup.reopenLastSection}
          onCheckedChange={(reopenLastSection) =>
            updateConfig((current) => ({
              ...current,
              startup: { ...current.startup, reopenLastSection },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Start minimized"
        description="Launch without bringing the window to the front."
      >
        <SettingsToggle
          label="Start minimized"
          checked={config.startup.startMinimized}
          onCheckedChange={(startMinimized) =>
            updateConfig((current) => ({
              ...current,
              startup: { ...current.startup, startMinimized },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function ResetSettingsSection({
  resetSettings,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Reset Settings"
      description="Put every group back to its shipped default."
    >
      <SettingsFieldRow
        label="Reset all settings"
        description="This cannot be undone."
      >
        <Dialog>
          <DialogTrigger
            render={
              <Button variant="destructive" size="sm">
                Reset
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset settings?</DialogTitle>
              <DialogDescription>
                Every setting returns to its default value. Queued downloads are
                left alone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={
                  <Button variant="outline" size="sm">
                    Cancel
                  </Button>
                }
              />
              <DialogClose
                render={
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={resetSettings}
                  >
                    Reset
                  </Button>
                }
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function VideoSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Video"
      description="Defaults applied to new video downloads."
    >
      <SettingsFieldRow
        label="Quality"
        description="Falls back to the closest available stream."
      >
        <SettingsSelectField
          value={config.video.quality}
          onValueChange={(quality) =>
            updateConfig((current) => ({
              ...current,
              video: {
                ...current.video,
                quality: quality as SettingsConfig["video"]["quality"],
              },
            }))
          }
          options={[
            { label: "Best available", value: "best" },
            { label: "1080p", value: "1080p" },
            { label: "720p", value: "720p" },
            { label: "480p", value: "480p" },
          ]}
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Container"
        description="Remuxed after download when needed."
      >
        <SettingsSelectField
          value={config.video.container}
          onValueChange={(container) =>
            updateConfig((current) => ({
              ...current,
              video: {
                ...current.video,
                container: container as SettingsConfig["video"]["container"],
              },
            }))
          }
          options={[
            { label: "MP4", value: "mp4" },
            { label: "MKV", value: "mkv" },
            { label: "WebM", value: "webm" },
          ]}
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Embed subtitles"
        description="Mux available subtitle tracks into the file."
      >
        <SettingsToggle
          label="Embed subtitles"
          checked={config.video.embedSubtitles}
          onCheckedChange={(embedSubtitles) =>
            updateConfig((current) => ({
              ...current,
              video: { ...current.video, embedSubtitles },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function AudioSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Audio"
      description="Defaults applied when extracting audio."
    >
      <SettingsFieldRow
        label="Format"
        description="Output codec and extension."
      >
        <SettingsSelectField
          value={config.audio.format}
          onValueChange={(format) =>
            updateConfig((current) => ({
              ...current,
              audio: {
                ...current.audio,
                format: format as SettingsConfig["audio"]["format"],
              },
            }))
          }
          options={[
            { label: "MP3", value: "mp3" },
            { label: "M4A", value: "m4a" },
            { label: "Opus", value: "opus" },
            { label: "WAV", value: "wav" },
          ]}
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Bitrate"
        description="Ignored for lossless formats."
        disabled={config.audio.format === "wav"}
      >
        <SettingsSliderField
          value={config.audio.bitrateKbps}
          min={64}
          max={320}
          step={32}
          formatValue={(bitrateKbps) => `${bitrateKbps} kbps`}
          onValueChange={(bitrateKbps) =>
            updateConfig((current) => ({
              ...current,
              audio: { ...current.audio, bitrateKbps },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Embed metadata"
        description="Write title, artist, and album tags."
      >
        <SettingsToggle
          label="Embed metadata"
          checked={config.audio.embedMetadata}
          onCheckedChange={(embedMetadata) =>
            updateConfig((current) => ({
              ...current,
              audio: { ...current.audio, embedMetadata },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Embed thumbnail"
        description="Use the source thumbnail as cover art."
      >
        <SettingsToggle
          label="Embed thumbnail"
          checked={config.audio.embedThumbnail}
          onCheckedChange={(embedThumbnail) =>
            updateConfig((current) => ({
              ...current,
              audio: { ...current.audio, embedThumbnail },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function NetworkSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Network"
      description="Bandwidth, retries, and how requests leave the machine."
    >
      <SettingsFieldRow
        label="Rate limit"
        description="Cap total download bandwidth."
      >
        <SettingsSliderField
          value={config.network.rateLimitKBps}
          min={0}
          max={50000}
          step={500}
          formatValue={(rateLimitKBps) =>
            rateLimitKBps === 0
              ? "Unlimited"
              : `${(rateLimitKBps / 1000).toFixed(1)} MB/s`
          }
          onValueChange={(rateLimitKBps) =>
            updateConfig((current) => ({
              ...current,
              network: { ...current.network, rateLimitKBps },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Retries"
        description="Attempts before a download is marked failed."
      >
        <SettingsSliderField
          value={config.network.retries}
          min={0}
          max={10}
          step={1}
          onValueChange={(retries) =>
            updateConfig((current) => ({
              ...current,
              network: { ...current.network, retries },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Proxy"
        description="Leave empty to connect directly."
      >
        <SettingsTextField
          value={config.network.proxyUrl}
          placeholder="http://127.0.0.1:8080"
          onValueChange={(proxyUrl) =>
            updateConfig((current) => ({
              ...current,
              network: { ...current.network, proxyUrl },
            }))
          }
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function DiagnosticsSection({
  config,
  updateConfig,
}: SettingsSectionComponentProps) {
  return (
    <SettingsPanel
      title="Diagnostics"
      description="Turn these up when reporting a problem."
    >
      <SettingsFieldRow
        label="Verbose logging"
        description="Record every transfer event."
      >
        <SettingsToggle
          label="Verbose logging"
          checked={config.diagnostics.verboseLogging}
          onCheckedChange={(verboseLogging) =>
            updateConfig((current) => ({
              ...current,
              diagnostics: { ...current.diagnostics, verboseLogging },
            }))
          }
        />
      </SettingsFieldRow>

      <SettingsFieldRow
        label="Log level"
        description="Lowest severity written to the log file."
      >
        <SettingsSelectField
          value={config.diagnostics.logLevel}
          onValueChange={(logLevel) =>
            updateConfig((current) => ({
              ...current,
              diagnostics: {
                ...current.diagnostics,
                logLevel: logLevel as SettingsConfig["diagnostics"]["logLevel"],
              },
            }))
          }
          options={[
            { label: "Error", value: "error" },
            { label: "Warn", value: "warn" },
            { label: "Info", value: "info" },
            { label: "Debug", value: "debug" },
          ]}
        />
      </SettingsFieldRow>
    </SettingsPanel>
  )
}

export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true

    void getAppVersion().then((value) => {
      if (mounted) {
        setVersion(value)
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  return (
    <SettingsPanel title="About" description="Build and app information.">
      <Empty className="border bg-muted/20 py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiDownloadLine />
          </EmptyMedia>
          <EmptyTitle>inferno-app</EmptyTitle>
          <EmptyDescription>
            {version ? `Version ${version}` : "Running outside Tauri"}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            size="sm"
            render={
              <a href="https://tauri.app" target="_blank" rel="noreferrer" />
            }
          >
            <RiGlobalLine data-icon="inline-start" />
            Website
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsPanel>
  )
}
