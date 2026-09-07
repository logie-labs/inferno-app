import DownloadsSection from "./downloads/downloads"
import LibrarySection from "./library/library"
import SettingsSection from "./settings/settings"
import type { SectionKey } from "./section-meta"

export const sections: Record<SectionKey, () => React.JSX.Element> = {
  downloads: DownloadsSection,
  library: LibrarySection,
  settings: SettingsSection,
}

// The identity of a section - its name, its icon, its place in the rail - lives
// in `section-meta` so things that need it do not have to pull in every screen.
export {
  footerSections,
  primarySections,
  sectionIcons,
  sectionLabels,
  sectionOrder,
  type SectionKey,
} from "./section-meta"
