import type { ComponentType } from "react"

import {
  RiArchiveLine,
  RiBugLine,
  RiDownloadCloud2Line,
  RiFolderLine,
  RiGlobalLine,
  RiInformationLine,
  RiKeyboardBoxLine,
  RiMusicLine,
  RiPaintBrushLine,
  RiRefreshLine,
  RiShutDownLine,
  RiSpotifyLine,
  RiVideoLine,
} from "@remixicon/react"

import {
  AboutSection,
  AppearanceSection,
  AudioSection,
  BackupSection,
  DiagnosticsSection,
  DownloadsSettingsSection,
  KeybindsSection,
  NetworkSection,
  ResetSettingsSection,
  SpotifySection,
  StartupSection,
  UpdatesSection,
  VideoSection,
} from "./components/settings-section-components"
import type { SettingsSectionComponentProps } from "./settings-config"

export type SettingsSectionId =
  | "appearance"
  | "downloads"
  | "startup"
  | "updates"
  | "keybinds"
  | "reset-settings"
  | "video"
  | "audio"
  | "spotify"
  | "network"
  | "backup"
  | "diagnostics"
  | "about"

// `integrations` is deliberately its own group rather than a corner of
// Media: what belongs in it is "other applications this one talks to",
// which is a different question from how a download is encoded.
export type SettingsGroupId =
  | "general"
  | "media"
  | "integrations"
  | "advanced"

export type SettingsNavItem = {
  id: SettingsSectionId
  title: string
  description: string
  icon: ComponentType<{ className?: string }>
}

export type SettingsSectionDefinition = SettingsNavItem & {
  group: SettingsGroupId
  component: ComponentType<SettingsSectionComponentProps>
}

export type SettingsNavGroup = {
  title: string
  items: SettingsNavItem[]
}

export const settingsSections: SettingsSectionDefinition[] = [
  {
    id: "appearance",
    group: "general",
    title: "Appearance",
    description: "Theme selection for the app.",
    icon: RiPaintBrushLine,
    component: AppearanceSection,
  },
  {
    id: "downloads",
    group: "general",
    title: "Downloads",
    description: "Save location, concurrency, and file naming.",
    icon: RiFolderLine,
    component: DownloadsSettingsSection,
  },
  {
    id: "keybinds",
    group: "general",
    title: "Shortcuts",
    description: "Rebind the command menu and everything it can run.",
    icon: RiKeyboardBoxLine,
    component: KeybindsSection,
  },
  {
    id: "startup",
    group: "general",
    title: "Startup",
    description: "Launch behavior and default window state.",
    icon: RiShutDownLine,
    component: StartupSection,
  },
  {
    id: "updates",
    group: "general",
    title: "Updates",
    description:
      "Check the app, the service, yt-dlp and the bundled tools for newer versions.",
    icon: RiDownloadCloud2Line,
    component: UpdatesSection,
  },
  {
    id: "reset-settings",
    group: "general",
    title: "Reset Settings",
    description: "Restore the full settings config to defaults.",
    icon: RiRefreshLine,
    component: ResetSettingsSection,
  },
  {
    id: "video",
    group: "media",
    title: "Video",
    description: "Preferred quality and container for video downloads.",
    icon: RiVideoLine,
    component: VideoSection,
  },
  {
    id: "audio",
    group: "media",
    title: "Audio",
    description: "Format, bitrate, and metadata for audio extraction.",
    icon: RiMusicLine,
    component: AudioSection,
  },
  {
    id: "spotify",
    group: "integrations",
    title: "Spotify",
    description: "Send finished audio into a Spotify local-files folder.",
    icon: RiSpotifyLine,
    component: SpotifySection,
  },
  {
    id: "network",
    group: "advanced",
    title: "Network",
    description: "Throttling, retries, and proxy configuration.",
    icon: RiGlobalLine,
    component: NetworkSection,
  },
  {
    id: "backup",
    group: "advanced",
    title: "Backup",
    description: "Export your settings to a file, or import them from one.",
    icon: RiArchiveLine,
    component: BackupSection,
  },
  {
    id: "diagnostics",
    group: "advanced",
    title: "Diagnostics",
    description: "Logs, troubleshooting, and checks.",
    icon: RiBugLine,
    component: DiagnosticsSection,
  },
  {
    id: "about",
    group: "advanced",
    title: "About",
    description: "Version and app information.",
    icon: RiInformationLine,
    component: AboutSection,
  },
]

export const settingsNavGroups: SettingsNavGroup[] = [
  {
    title: "General",
    items: settingsSections.filter((section) => section.group === "general"),
  },
  {
    title: "Media",
    items: settingsSections.filter((section) => section.group === "media"),
  },
  {
    title: "Integrations",
    items: settingsSections.filter(
      (section) => section.group === "integrations"
    ),
  },
  {
    title: "Advanced",
    items: settingsSections.filter((section) => section.group === "advanced"),
  },
]

export const settingsSectionMap = Object.fromEntries(
  settingsSections.map((section) => [section.id, section])
) as Record<SettingsSectionId, SettingsSectionDefinition>
