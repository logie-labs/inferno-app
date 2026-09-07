/**
 * Keyboard shortcuts: one canonical string form, and the three things anyone
 * needs to do with it - read one off an event, match one against an event, and
 * show one to a person.
 *
 * A binding is written modifiers-first in a fixed order, e.g. `Ctrl+Alt+K`.
 * Fixing the order is what makes two bindings comparable as plain strings, so
 * storage, conflict detection and lookup are all just string equality and no
 * part of the app has to parse anything.
 *
 * **Physical keys, not typed characters.** The key is taken from
 * `KeyboardEvent.code` rather than `.key`, because `.key` is what the layout
 * *produces*: holding Alt on Windows can yield a dead key or a different
 * character entirely, and on a non-US layout `Ctrl+Alt+K` is not necessarily
 * reachable at all. `code` names the physical key, so a binding survives the
 * layout it was recorded on.
 */

/** Fixed order. Two equal chords must produce byte-identical strings. */
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const

/** Codes that are *only* a modifier. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
])

/**
 * Codes whose name is not what anyone would call the key.
 *
 * Only the ones that actually read wrong. `Enter`, `Escape`, `ArrowUp` and the
 * function keys are already their own names, so they pass through untouched.
 */
const CODE_LABELS: Record<string, string> = {
  Space: "Space",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Delete: "Del",
}

/** The key half of a binding, from a physical key code. */
function keyFromCode(code: string): string | null {
  if (!code || MODIFIER_CODES.has(code)) {
    return null
  }

  // `KeyK` -> `K`, `Digit4` -> `4`, `Numpad4` -> `Num4`.
  if (code.startsWith("Key")) {
    return code.slice(3)
  }
  if (code.startsWith("Digit")) {
    return code.slice(5)
  }
  if (code.startsWith("Numpad")) {
    return `Num${code.slice(6)}`
  }

  return CODE_LABELS[code] ?? code
}

/**
 * The binding a key press represents, or null when it is not one yet.
 *
 * Null covers the ordinary case of a modifier being held down before the rest
 * of the chord arrives - a recorder must not treat that as the finished answer.
 */
export function keybindFromEvent(event: KeyboardEvent): string | null {
  const key = keyFromCode(event.code)
  if (!key) {
    return null
  }

  const parts: string[] = []
  if (event.ctrlKey) {
    parts.push("Ctrl")
  }
  if (event.altKey) {
    parts.push("Alt")
  }
  if (event.shiftKey) {
    parts.push("Shift")
  }
  if (event.metaKey) {
    parts.push("Meta")
  }

  parts.push(key)

  return parts.join("+")
}

/** Whether a press is exactly this binding - no extra modifiers allowed. */
export function matchesKeybind(event: KeyboardEvent, binding: string) {
  return Boolean(binding) && keybindFromEvent(event) === binding
}

/** Whether a key press is a modifier and nothing else. */
export function isModifierCode(code: string) {
  return MODIFIER_CODES.has(code)
}

/**
 * The modifiers held during an event, in canonical order.
 *
 * On a `keyup` the released modifier is already excluded, so an empty result
 * means the whole chord has now been let go.
 */
export function modifierChord(event: KeyboardEvent) {
  const parts: string[] = []
  if (event.ctrlKey) {
    parts.push("Ctrl")
  }
  if (event.altKey) {
    parts.push("Alt")
  }
  if (event.shiftKey) {
    parts.push("Shift")
  }
  if (event.metaKey) {
    parts.push("Meta")
  }

  return parts.join("+")
}

/**
 * A binding that is only modifiers, e.g. `Ctrl+Alt`.
 *
 * These are matched on *release*, not on press - a tap, the way Shift-Shift
 * works in a JetBrains IDE. Firing on press would be unusable: `Ctrl+Alt` would
 * trigger the moment those two went down and swallow every chord built on top
 * of them, `Ctrl+Alt+K` included. Waiting for the release, and only when no
 * other key was pressed in between, leaves every longer chord intact.
 */
export function isModifierOnly(binding: string) {
  if (!binding) {
    return false
  }

  return binding
    .split("+")
    .every((part) => (MODIFIER_ORDER as readonly string[]).includes(part))
}

/**
 * A binding no chord can ever contain a modifier for.
 *
 * A bare letter would fire while typing into the URL bar, so a shortcut that
 * works app-wide needs at least one modifier. Function keys are the exception -
 * they are not typing.
 */
export function needsModifier(binding: string) {
  const parts = binding.split("+")
  if (parts.length > 1) {
    return false
  }

  const key = parts[0] ?? ""

  return !/^F\d{1,2}$/.test(key)
}

const isApple =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

const DISPLAY: Record<string, string> = {
  Ctrl: isApple ? "⌃" : "Ctrl",
  Alt: isApple ? "⌥" : "Alt",
  Shift: isApple ? "⇧" : "Shift",
  Meta: isApple ? "⌘" : "Win",
}

/** The keys of a binding, each already named the way it should be shown. */
export function keybindParts(binding: string): string[] {
  if (!binding) {
    return []
  }

  return binding.split("+").map((part) => DISPLAY[part] ?? part)
}

/** A binding as one string, for a title attribute or a plain-text context. */
export function formatKeybind(binding: string) {
  const parts = keybindParts(binding)
  if (parts.length === 0) {
    return "Not set"
  }

  return parts.join(isApple ? "" : " + ")
}

/**
 * Whether the event came from somewhere the user is typing.
 *
 * A shortcut with modifiers is generally safe mid-typing, but a plain one is
 * not, and the palette itself has a text input - so the check lives here where
 * every consumer can share one definition of "they are writing something".
 */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}
