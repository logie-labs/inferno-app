/**
 * Naming a downloaded file.
 *
 * The template is edited as a sequence of *parts* - literal text and tokens -
 * rather than as one string with braces in it. That is what lets the editor
 * draw tokens as pills: a pill is a part, not a run of characters somebody
 * might delete half of.
 *
 * It is stored as a string all the same, because a string is what settings
 * export and import, and what a person can read in a config file.
 */

/** What a token puts in the name, and what yt-dlp is asked for. */
export type TokenDefinition = {
  id: string
  label: string
  /** What it looks like for a typical video, for the preview and the menu. */
  example: string
  /** The yt-dlp output-template field, brace-free. */
  field: string
  group: "Video" | "Channel" | "Date" | "Format" | "Playlist"
}

/**
 * The fields worth offering, in the order the menu shows them.
 *
 * `ext` is deliberately absent. yt-dlp always appends the real extension, and
 * a template that names it either duplicates it (`clip.mp4.mp4`) or lies about
 * it - the container is decided by the format that was actually downloaded, not
 * by what the name says. It is shown after the editor as a fixed suffix so it
 * is clear the file still gets one.
 */
export const TOKENS: TokenDefinition[] = [
  {
    id: "title",
    label: "Title",
    example: "Video title",
    field: "title",
    group: "Video",
  },
  { id: "id", label: "Video ID", example: "aBcD1efGhIj", field: "id", group: "Video" },
  {
    id: "duration",
    label: "Duration",
    example: "4:12",
    field: "duration_string",
    group: "Video",
  },
  {
    id: "channel",
    label: "Channel",
    example: "Channel name",
    field: "channel",
    group: "Channel",
  },
  {
    id: "uploader",
    label: "Uploader",
    example: "Uploader name",
    field: "uploader",
    group: "Channel",
  },
  {
    id: "date",
    label: "Upload date",
    example: "2024-03-18",
    // yt-dlp gives `20091025`; the `>` suffix is its own strftime formatting.
    field: "upload_date>%Y-%m-%d",
    group: "Date",
  },
  {
    id: "year",
    label: "Year",
    example: "2024",
    field: "upload_date>%Y",
    group: "Date",
  },
  {
    id: "resolution",
    label: "Resolution",
    example: "1920x1080",
    field: "resolution",
    group: "Format",
  },
  {
    id: "height",
    label: "Quality",
    example: "1080p",
    field: "height",
    group: "Format",
  },
  {
    id: "format",
    label: "Format ID",
    example: "137",
    field: "format_id",
    group: "Format",
  },
  {
    id: "source",
    label: "Source",
    example: "Youtube",
    field: "extractor_key",
    group: "Format",
  },
  {
    id: "playlist",
    label: "Playlist",
    example: "Playlist name",
    field: "playlist_title",
    group: "Playlist",
  },
  {
    id: "index",
    label: "Position",
    example: "003",
    field: "playlist_index",
    group: "Playlist",
  },
]

export const TOKEN_BY_ID = new Map(TOKENS.map((token) => [token.id, token]))

/**
 * What an empty template actually names the file.
 *
 * Emptying the field is not an error and does not produce a nameless file - it
 * falls back to the title, which is what yt-dlp would have done anyway. Kept
 * here so the preview, the placeholder and the template handed to the service
 * cannot disagree about what "empty" does.
 */
export const FALLBACK_TEMPLATE = "{title}"

export function effectiveTemplate(template: string) {
  return template.trim() || FALLBACK_TEMPLATE
}

export type TemplatePart =
  | { kind: "text"; value: string }
  | { kind: "token"; id: string }

/** How the finished name is cased. */
export type CaseStyle = "original" | "kebab" | "snake" | "lower" | "title"

export const CASE_STYLES: { value: CaseStyle; label: string; example: string }[] =
  [
    { value: "original", label: "Original", example: "Video title" },
    { value: "kebab", label: "kebab-case", example: "video-title" },
    { value: "snake", label: "snake_case", example: "video_title" },
    { value: "lower", label: "lower case", example: "video title" },
    { value: "title", label: "Title Case", example: "Video Title" },
  ]

/**
 * `{title} [{id}]` -> parts.
 *
 * An unknown token is kept as literal text rather than dropped: someone may
 * have written a yt-dlp field this app does not list, and silently deleting it
 * would be worse than showing it as it was typed.
 */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  const pattern = /\{([a-z_]+)\}/gi
  let at = 0

  for (const match of template.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > at) {
      parts.push({ kind: "text", value: template.slice(at, start) })
    }

    const id = match[1].toLowerCase()
    if (TOKEN_BY_ID.has(id)) {
      parts.push({ kind: "token", id })
    } else {
      parts.push({ kind: "text", value: match[0] })
    }

    at = start + match[0].length
  }

  if (at < template.length) {
    parts.push({ kind: "text", value: template.slice(at) })
  }

  return parts
}

/** Parts -> the stored `{title} [{id}]` form. */
export function serialiseTemplate(parts: TemplatePart[]) {
  return parts
    .map((part) => (part.kind === "text" ? part.value : `{${part.id}}`))
    .join("")
}

/** What the name would look like, for the line under the editor. */
export function previewTemplate(template: string, style: CaseStyle) {
  const rendered = parseTemplate(effectiveTemplate(template))
    .map((part) =>
      part.kind === "text"
        ? part.value
        : (TOKEN_BY_ID.get(part.id)?.example ?? part.id)
    )
    .join("")

  return applyCase(rendered, style)
}

/**
 * Case a finished name.
 *
 * Runs on the whole name rather than per token, because that is what makes it
 * consistent: `{channel} - {title}` in kebab-case should be one hyphenated run,
 * not two cased fragments joined by a stray space and a dash.
 *
 * Exported because the same rule has to be applied to the real filename, not
 * only to the preview.
 */
export function applyCase(name: string, style: CaseStyle) {
  if (style === "original") {
    return name
  }

  if (style === "lower") {
    return name.toLowerCase()
  }

  if (style === "title") {
    return name.replace(
      /\w\S*/g,
      (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()
    )
  }

  const separator = style === "kebab" ? "-" : "_"

  return name
    .toLowerCase()
    // Anything that is not a word character becomes the separator, then runs
    // of separators collapse - so " - " does not turn into three of them.
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`\\${separator}{2,}`, "g"), separator)
    .replace(new RegExp(`^\\${separator}|\\${separator}$`, "g"), "")
}

/**
 * The template as yt-dlp wants it.
 *
 * Emitted in yt-dlp's own `%(field)s` syntax rather than the friendly braces,
 * because the service passes a template containing `%(` straight through - and
 * that is the only way to reach field formatting like `upload_date>%Y-%m-%d`.
 * It is all or nothing: one raw field means every field must be raw.
 *
 * The extension is appended here and nowhere else, so it cannot be doubled or
 * left off by anything the user types.
 */
export function toServiceTemplate(template: string) {
  const body = parseTemplate(effectiveTemplate(template))
    .map((part) =>
      part.kind === "text"
        ? part.value
        : `%(${TOKEN_BY_ID.get(part.id)?.field ?? part.id})s`
    )
    .join("")
    .trim()

  return `${body || "%(title)s"}.%(ext)s`
}
