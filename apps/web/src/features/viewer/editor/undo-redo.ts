import type { CameraSnapshot, EditEntry, EditOperation } from './edit-log'
import { appendEntry, createEditLog } from './edit-log'

/**
 * Edit session: an append-only edit log plus a pointer for undo/redo.
 *
 * - `entries[0..pointer-1]` are "active" (applied to the view).
 * - `entries[pointer..]` are "undone" (available for redo).
 * - A new edit after undo truncates everything after the pointer.
 */
export interface EditSession {
  readonly entries: readonly EditEntry[]
  readonly pointer: number // index of next entry to apply (= count of active entries)
}

export function createEditSession(entries: readonly EditEntry[] = []): EditSession {
  return { entries, pointer: entries.length }
}

export function activeEntries(session: EditSession): readonly EditEntry[] {
  return session.entries.slice(0, session.pointer)
}

export function canUndo(session: EditSession): boolean {
  return session.pointer > 0
}

export function canRedo(session: EditSession): boolean {
  return session.pointer < session.entries.length
}

export function undo(session: EditSession): EditSession {
  if (!canUndo(session))
    return session
  return { ...session, pointer: session.pointer - 1 }
}

export function redo(session: EditSession): EditSession {
  if (!canRedo(session))
    return session
  return { ...session, pointer: session.pointer + 1 }
}

/**
 * Apply a new edit. Truncates any undone entries (redo history)
 * then appends the new operation.
 */
export function applyEdit(
  session: EditSession,
  operation: EditOperation,
  cameraState: CameraSnapshot | null = null,
): EditSession {
  // Truncate redo history
  const truncated = createEditLog(session.entries.slice(0, session.pointer))
  const newLog = appendEntry(truncated, operation, cameraState)
  return {
    entries: newLog.entries,
    pointer: newLog.entries.length,
  }
}
