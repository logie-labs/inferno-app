/**
 * Asking what to do about a file that is already there.
 *
 * A broker rather than a hook, because the two things that place files are not
 * both React. The automatic delivery runs from the service provider's socket
 * handler - a plain async function with no component around it - and the row
 * menu runs from a click. Both need to stop and ask the same question, so the
 * question lives here and the dialog registers itself as the thing that
 * answers it.
 *
 * With no dialog mounted, `askAboutConflict` answers `keep_both`. That is the
 * behaviour this replaced, and it is the only safe default: it never destroys
 * the file already there, and never silently discards the new one.
 */

export type ConflictDecision = "replace" | "keep_both" | "skip"

export type ConflictQuestion = {
  /** The file being delivered. */
  incomingName: string
  incomingSize: number
  /** The one already in the folder. */
  existingName: string
  existingSize: number
  existingModified: number | null
  folder: string
  /** How many more are waiting, so the dialog can offer "do this for the rest". */
  remaining: number
}

export type ConflictAnswer = {
  decision: ConflictDecision
  /** Apply this to every remaining conflict without asking again. */
  applyToRest: boolean
}

type Asker = (question: ConflictQuestion) => Promise<ConflictAnswer>

let asker: Asker | null = null

/** The dialog calls this on mount, and passes null on unmount. */
export function setConflictAsker(next: Asker | null) {
  asker = next
}

export async function askAboutConflict(
  question: ConflictQuestion
): Promise<ConflictAnswer> {
  if (!asker) {
    return { decision: "keep_both", applyToRest: true }
  }

  try {
    return await asker(question)
  } catch {
    // A dialog that went away mid-question is not a reason to overwrite
    // anything.
    return { decision: "keep_both", applyToRest: false }
  }
}
