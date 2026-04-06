import type { EditLogEntry } from '../cache/idb-store'
import type { CameraSnapshot, EditOperation } from '../editor/edit-log'
import type { EditSession } from '../editor/undo-redo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteEditLogs, getEditLogs, putEditLog } from '../cache/idb-store'
import { deserializeEntry, serializeEntry } from '../editor/edit-log'
import {
  activeEntries,
  applyEdit,
  canRedo,
  canUndo,
  createEditSession,
  redo,
  undo,
} from '../editor/undo-redo'

export interface UseEditSessionReturn {
  session: EditSession
  activeEntries: EditSession['entries']
  canUndo: boolean
  canRedo: boolean
  apply: (operation: EditOperation, cameraState?: CameraSnapshot | null) => void
  undoEdit: () => void
  redoEdit: () => void
  clearAll: () => void
  isLoaded: boolean
}

export function useEditSession(datasetId: string | null): UseEditSessionReturn {
  const [session, setSession] = useState<EditSession>(createEditSession)
  const [isLoaded, setIsLoaded] = useState(false)
  const persistRef = useRef(true)

  // Load edit log from IndexedDB on mount / dataset change
  useEffect(() => {
    if (!datasetId) {
      setSession(createEditSession())
      setIsLoaded(true)
      return
    }

    let cancelled = false
    setIsLoaded(false)

    getEditLogs(datasetId)
      .then((raw) => {
        if (cancelled)
          return
        const sorted = raw.sort((a, b) => a.timestamp - b.timestamp)
        const entries = sorted.map(r =>
          deserializeEntry({
            id: r.id,
            operation: r.operation,
            payload: r.payload as ReturnType<typeof serializeEntry>['payload'],
            affectedTileIds: (r.payload as Record<string, unknown>).affectedTileIds as string[] ?? [],
            cameraState: (r.payload as Record<string, unknown>).cameraState as CameraSnapshot | null ?? null,
            timestamp: r.timestamp,
          }),
        )
        setSession(createEditSession(entries))
        setIsLoaded(true)
      })
      .catch(() => {
        if (!cancelled) {
          setSession(createEditSession())
          setIsLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [datasetId])

  // Persist a single entry to IndexedDB
  const persistEntry = useCallback((datasetId: string, serialized: ReturnType<typeof serializeEntry>) => {
    const idbEntry: EditLogEntry = {
      id: serialized.id,
      datasetId,
      timestamp: serialized.timestamp,
      operation: serialized.operation,
      payload: {
        ...serialized.payload,
        affectedTileIds: serialized.affectedTileIds,
        cameraState: serialized.cameraState,
      },
    }
    putEditLog(idbEntry).catch(() => { /* best-effort persistence */ })
  }, [])

  const apply = useCallback((operation: EditOperation, cameraState: CameraSnapshot | null = null) => {
    setSession((prev) => {
      const next = applyEdit(prev, operation, cameraState)
      // Persist the newly added entry
      if (datasetId && persistRef.current) {
        const newEntry = next.entries.at(-1)
        if (newEntry) {
          persistEntry(datasetId, serializeEntry(newEntry))
        }
      }
      return next
    })
  }, [datasetId, persistEntry])

  const undoEdit = useCallback(() => {
    setSession(prev => undo(prev))
  }, [])

  const redoEdit = useCallback(() => {
    setSession(prev => redo(prev))
  }, [])

  const clearAll = useCallback(() => {
    setSession(createEditSession())
    if (datasetId) {
      deleteEditLogs(datasetId).catch(() => { /* best-effort */ })
    }
  }, [datasetId])

  return {
    session,
    activeEntries: activeEntries(session),
    canUndo: canUndo(session),
    canRedo: canRedo(session),
    apply,
    undoEdit,
    redoEdit,
    clearAll,
    isLoaded,
  }
}
