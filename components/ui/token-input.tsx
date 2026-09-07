"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"

import { inputClassName } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export type TokenOption = {
  id: string
  label: string
  example: string
  group: string
}

/** Where the caret is, and what it is in the middle of. */
type CaretContext =
  /** A closed token, typed out in full: `{title}`. */
  | { kind: "closed"; node: Text; start: number; end: number; id: string }
  /** An open brace and whatever has been typed since: `{ti`. */
  | { kind: "open"; node: Text; start: number; end: number; query: string }

/**
 * A text field where some of the text is objects.
 *
 * Built on `contentEditable` rather than an `<input>` with an overlay, because
 * the pills have to sit *in* the text flow: they wrap with it, the caret moves
 * around them, and Backspace deletes one whole token rather than eating
 * `{titl` and leaving `e}` behind. An overlay can imitate that until the text
 * wraps, at which point the illusion comes apart.
 *
 * The DOM is the source of truth only while typing. Every change is serialised
 * back to a string immediately, and the string is what is stored - so nothing
 * downstream has to know this component exists.
 */
export function TokenInput({
  value,
  onValueChange,
  tokens,
  placeholder,
  suffix,
  className,
}: {
  /** The stored form, e.g. `{title} [{id}]`. */
  value: string
  onValueChange: (next: string) => void
  tokens: TokenOption[]
  placeholder?: string
  /** Fixed, uneditable text shown after the field - the file extension. */
  suffix?: string
  className?: string
}) {
  const editor = useRef<HTMLDivElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const listId = useId()
  /** What has been typed after an open brace; null when no menu is open. */
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  /** DOM -> the stored string. */
  const read = useCallback(() => {
    const root = editor.current
    if (!root) {
      return ""
    }

    let out = ""
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent ?? ""
      } else if (node instanceof HTMLElement) {
        const id = node.dataset.token
        out += id ? `{${id}}` : (node.textContent ?? "")
      }
    }

    return out
  }, [])

  const emit = useCallback(() => {
    onValueChange(read())
  }, [onValueChange, read])

  /**
   * The stored string -> DOM, but only when they have actually diverged.
   *
   * Rewriting the editor's contents on every render would move the caret to
   * the start on every keystroke. Comparing first means this only runs when
   * the value changed from the outside - a preset button, a reset, an import.
   */
  useEffect(() => {
    const root = editor.current
    if (!root || read() === value) {
      return
    }

    root.replaceChildren()
    const pattern = /\{([a-z_]+)\}/gi
    let at = 0

    const addText = (text: string) => {
      if (text) {
        root.appendChild(document.createTextNode(text))
      }
    }

    for (const match of value.matchAll(pattern)) {
      const start = match.index ?? 0
      addText(value.slice(at, start))

      const id = match[1].toLowerCase()
      const known = tokens.find((token) => token.id === id)
      if (known) {
        root.appendChild(pill(known))
      } else {
        addText(match[0])
      }
      at = start + match[0].length
    }
    addText(value.slice(at))
  }, [read, tokens, value])

  /**
   * Show the pills as selected when a selection covers them.
   *
   * The browser paints its selection colour behind text, but a pill has its
   * own background, so Ctrl+A left the tokens looking untouched beside text
   * that was obviously highlighted. Marked straight on the DOM rather than in
   * state: the pills are not React's to render, and a selection changes far
   * too often to re-render for.
   */
  useEffect(() => {
    const mark = () => {
      const root = editor.current
      if (!root) {
        return
      }

      const selection = window.getSelection()
      const range =
        selection && !selection.isCollapsed && selection.rangeCount
          ? selection.getRangeAt(0)
          : null

      for (const node of Array.from(root.children)) {
        if (!(node instanceof HTMLElement) || !node.dataset.token) {
          continue
        }

        // The string "true", not a bare attribute: Tailwind's `data-selected`
        // variant compiles to `[data-selected="true"]`, so an empty value -
        // which is what `toggleAttribute` writes - matches nothing.
        if (range?.intersectsNode(node)) {
          node.dataset.selected = "true"
        } else {
          delete node.dataset.selected
        }
      }
    }

    document.addEventListener("selectionchange", mark)

    return () => document.removeEventListener("selectionchange", mark)
  }, [])

  /**
   * Put a token in, replacing the text it grew out of.
   *
   * `over` is the `{ti` that was being typed, so the braces disappear into the
   * pill rather than being left sitting next to it. Without it the token lands
   * wherever the caret is, which is what the list underneath wants.
   */
  const insert = useCallback(
    (token: TokenOption, over?: CaretContext) => {
      const root = editor.current
      if (!root) {
        return
      }

      root.focus()
      const selection = window.getSelection()
      const range = document.createRange()

      if (over) {
        range.setStart(over.node, over.start)
        range.setEnd(over.node, over.end)
      } else {
        const live = selection?.rangeCount ? selection.getRangeAt(0) : null
        if (live && root.contains(live.commonAncestorContainer)) {
          range.setStart(live.startContainer, live.startOffset)
          range.setEnd(live.endContainer, live.endOffset)
        } else {
          // No caret to speak of - a click on the list while the field has
          // never been focused. The end is the only sensible place.
          range.selectNodeContents(root)
          range.collapse(false)
        }
      }

      range.deleteContents()
      // A trailing space, so typing after a pill does not run into it and the
      // caret has somewhere to land that is not inside the token.
      const spacer = document.createTextNode(" ")
      range.insertNode(spacer)
      range.insertNode(pill(token))

      range.setStartAfter(spacer)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)

      setQuery(null)
      setActive(0)
      emit()
    },
    [emit]
  )

  /**
   * React to the text or the caret having moved.
   *
   * Two things happen here: a token typed or pasted out in full becomes a pill
   * the moment its closing brace lands, and an unfinished one opens the menu.
   */
  const sync = useCallback(() => {
    const root = editor.current
    if (!root) {
      return
    }

    const context = caretContext(root)

    if (context?.kind === "closed") {
      const known = tokens.find((token) => token.id === context.id)
      if (known) {
        insert(known, context)
        return
      }
    }

    // Only reset the highlight when the menu's contents actually change.
    // Resetting on every sync put it back on the first row a moment after an
    // arrow key had moved it, because key-up syncs after key-down.
    const next = context?.kind === "open" ? context.query : null
    if (next !== query) {
      setQuery(next)
      setActive(0)
    }

    emit()
  }, [emit, insert, query, tokens])

  const matches =
    query === null
      ? []
      : tokens.filter(
          (token) =>
            token.id.startsWith(query) ||
            token.label.toLowerCase().includes(query)
        )

  /**
   * Keep the highlighted row on screen.
   *
   * The list scrolls once every token is in it, and arrowing down to a row
   * that has been scrolled out of sight looks like nothing happening at all.
   */
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" })
  }, [active])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        {/* The app's own input, underline and all. `focus-within` rather
            than `focus-visible`, because the thing being focused is the
            editable region inside, not this. */}
        <div
          className={cn(
            inputClassName,
            "flex h-auto min-h-10 items-center focus-within:border-b-ring"
          )}
        >
          <div
            ref={editor}
            contentEditable
            suppressContentEditableWarning
            // A combobox rather than a plain textbox: it is a text field
            // that offers a list, and screen readers announce the difference.
            role="combobox"
            aria-label="Filename template"
            aria-autocomplete="list"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            data-placeholder={placeholder}
            // Not `:empty`: deleting the last pill leaves a stray <br> behind,
            // so the element is no longer empty and the CSS placeholder never
            // came back. The stored value is the honest test.
            data-empty={value.trim() ? undefined : ""}
            onInput={sync}
            onClick={(event) => {
              // A pill is one object, so removing it is one click rather than
              // a caret trip to its far side and a Backspace.
              const pill = (event.target as HTMLElement).closest?.(
                "[data-token]"
              )
              if (pill && editor.current?.contains(pill)) {
                // The space that was inserted with it goes too, so removing a
                // token does not leave a gap behind where it used to be.
                const after = pill.nextSibling
                if (
                  after?.nodeType === Node.TEXT_NODE &&
                  after.textContent === " "
                ) {
                  after.parentNode?.removeChild(after)
                }

                pill.remove()
                setQuery(null)
                emit()
                return
              }

              sync()
            }}
            onKeyUp={(event) => {
              // While the menu is open the arrows drive it, not the caret, and
              // key-down has already swallowed them.
              if (matches.length > 0) {
                return
              }

              // Moving the caret can take it out of a half-typed token, or
              // back into one, without any text having changed.
              if (
                event.key.startsWith("Arrow") ||
                event.key === "Home" ||
                event.key === "End"
              ) {
                sync()
              }
            }}
            onKeyDown={(event) => {
              if (matches.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setActive((at) => (at + 1) % matches.length)
                  return
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setActive((at) => (at - 1 + matches.length) % matches.length)
                  return
                }

                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault()
                  const root = editor.current
                  const context = root ? caretContext(root) : null
                  insert(
                    matches[active],
                    context?.kind === "open" ? context : undefined
                  )
                  return
                }

                if (event.key === "Escape") {
                  event.preventDefault()
                  setQuery(null)
                  return
                }
              }

              // A single line: Enter would insert a <div> and break the shape.
              if (event.key === "Enter") {
                event.preventDefault()
              }
            }}
            onBlur={() => {
              setQuery(null)
              emit()
            }}
            className={cn(
              "min-h-9 flex-1 px-0 py-1.5 font-mono text-[13px] leading-6 whitespace-pre-wrap outline-none",
              "data-empty:before:text-muted-foreground data-empty:before:content-[attr(data-placeholder)]"
            )}
          />
          {suffix ? (
            // Outside the editable region entirely, so it cannot be typed over
            // or deleted.
            <span className="shrink-0 pl-1 font-mono text-[13px] text-muted-foreground select-none">
              {suffix}
            </span>
          ) : null}
        </div>

        {matches.length > 0 ? (
          // Every token, not a shortlist - the point of the menu is to
          // say what there is. Capped in height rather than in count, so a
          // long list scrolls instead of hiding its tail.
          //
          // The cap belongs on the viewport, not on the root: the viewport is
          // `size-full`, and inside something sized by `max-height` alone that
          // resolves to `auto`, so nothing would ever overflow or scroll.
          <ScrollArea
            className="absolute top-full left-0 z-50 mt-1 w-full max-w-xs border bg-popover shadow-md"
            viewportClassName="max-h-56"
          >
            <div ref={list} id={listId} role="listbox" aria-label="Tokens">
              {matches.map((token, at) => (
                <button
                  key={token.id}
                  type="button"
                  role="option"
                  aria-selected={at === active}
                  // Keeps the caret where it is: without this the field blurs on
                  // press, the selection is gone, and the token lands at the end.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => {
                    const root = editor.current
                    const context = root ? caretContext(root) : null
                    insert(
                      token,
                      context?.kind === "open" ? context : undefined
                    )
                  }}
                  className={cn(
                    "flex w-full items-baseline justify-between gap-3 px-2 py-1.5 text-left text-xs",
                    at === active ? "bg-accent text-accent-foreground" : ""
                  )}
                >
                  <span className="truncate">{token.label}</span>
                  <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                    {token.example}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        ) : null}
      </div>

      {/* Every token, always visible. A menu that only appears on `{` hides
          what is possible from anyone who has not been told the trick. */}
      <div className="flex flex-wrap gap-1">
        {tokens.map((token) => (
          <button
            key={token.id}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(token)}
            title={`Inserts: ${token.example}`}
            className="border border-input px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            {token.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * What the caret is sitting after, if it is anything.
 *
 * Only text nodes count: there is nothing to complete inside a pill, and a
 * caret between two pills is not in the middle of typing a token.
 */
function caretContext(root: HTMLElement): CaretContext | null {
  const selection = window.getSelection()
  if (!selection || !selection.isCollapsed) {
    return null
  }

  const node = selection.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) {
    return null
  }

  const at = selection.anchorOffset
  const before = (node.textContent ?? "").slice(0, at)

  const closed = /\{([a-z_]+)\}$/i.exec(before)
  if (closed) {
    return {
      kind: "closed",
      node: node as Text,
      start: at - closed[0].length,
      end: at,
      id: closed[1].toLowerCase(),
    }
  }

  const open = /\{([a-z_]*)$/i.exec(before)
  if (open) {
    return {
      kind: "open",
      node: node as Text,
      start: at - open[0].length,
      end: at,
      query: open[1].toLowerCase(),
    }
  }

  return null
}

/**
 * One token, as it appears in the field.
 *
 * `contentEditable=false` is what makes it behave as a single object: the
 * caret steps over it, and Backspace removes the whole thing rather than
 * turning it back into editable characters.
 */
function pill(token: TokenOption) {
  const node = document.createElement("span")
  node.dataset.token = token.id
  node.contentEditable = "false"
  node.textContent = token.label
  node.title = `${token.example} - click to remove`
  // Its own line-height, not the editor's. An inline-block inherits `leading-6`
  // and is 24px tall before any padding, which fills the whole line and leaves
  // the pills looking like buttons rather than words.
  node.className =
    "mx-0.5 inline-block h-[18px] cursor-pointer select-none bg-muted px-1 align-middle font-sans text-[11px] leading-[18px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-destructive/10 hover:text-destructive hover:shadow-[inset_0_0_0_1px_var(--destructive)] data-selected:bg-destructive/10 data-selected:text-destructive data-selected:shadow-[inset_0_0_0_1px_var(--destructive)]"

  return node
}
