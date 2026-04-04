import type { Bounds } from '../data/types'

// --- Operation types (discriminated union) ---

export interface DeleteBySelectionOp {
  type: 'deleteBySelection'
  masks: TileMask[]
}

export interface KeepByAABBOp {
  type: 'keepByAABB'
  bounds: Bounds
}

export interface FilterByClassificationOp {
  type: 'filterByClassification'
  classes: number[]
}

export interface FilterByRangeOp {
  type: 'filterByRange'
  attribute: string
  min: number
  max: number
}

export type EditOperation
  = | DeleteBySelectionOp
    | KeepByAABBOp
    | FilterByClassificationOp
    | FilterByRangeOp

export interface TileMask {
  tileId: string
  mask: Uint8Array // 1 = selected/deleted, 0 = keep
}

export interface CameraSnapshot {
  position: [number, number, number]
  target: [number, number, number]
}

// --- Edit log entry ---

export interface EditEntry {
  id: string
  operation: EditOperation
  affectedTileIds: string[]
  cameraState: CameraSnapshot | null
  timestamp: number
}

// --- Append-only edit log ---

export interface EditLog {
  readonly entries: readonly EditEntry[]
}

let idCounter = 0

export function generateEntryId(): string {
  idCounter += 1
  return `edit-${Date.now()}-${idCounter}`
}

export function createEditLog(entries: readonly EditEntry[] = []): EditLog {
  return { entries }
}

export function appendEntry(
  log: EditLog,
  operation: EditOperation,
  cameraState: CameraSnapshot | null = null,
): EditLog {
  const affectedTileIds = extractAffectedTileIds(operation)
  const entry: EditEntry = {
    id: generateEntryId(),
    operation,
    affectedTileIds,
    cameraState,
    timestamp: Date.now(),
  }
  return { entries: [...log.entries, entry] }
}

function extractAffectedTileIds(operation: EditOperation): string[] {
  if (operation.type === 'deleteBySelection') {
    return operation.masks.map(m => m.tileId)
  }
  // Parametric operations affect all tiles — return empty to signal "all"
  return []
}

// --- Serialization for IndexedDB ---

export interface SerializedEditEntry {
  id: string
  operation: string
  payload: SerializedPayload
  affectedTileIds: string[]
  cameraState: CameraSnapshot | null
  timestamp: number
}

type SerializedPayload
  = | { masks: Array<{ tileId: string, mask: number[] }> }
    | { bounds: Bounds }
    | { classes: number[] }
    | { attribute: string, min: number, max: number }

export function serializeEntry(entry: EditEntry): SerializedEditEntry {
  const { operation } = entry
  let payload: SerializedPayload

  switch (operation.type) {
    case 'deleteBySelection':
      payload = {
        masks: operation.masks.map(m => ({
          tileId: m.tileId,
          mask: Array.from(m.mask),
        })),
      }
      break
    case 'keepByAABB':
      payload = { bounds: operation.bounds }
      break
    case 'filterByClassification':
      payload = { classes: operation.classes }
      break
    case 'filterByRange':
      payload = { attribute: operation.attribute, min: operation.min, max: operation.max }
      break
  }

  return {
    id: entry.id,
    operation: operation.type,
    payload,
    affectedTileIds: entry.affectedTileIds,
    cameraState: entry.cameraState,
    timestamp: entry.timestamp,
  }
}

export function deserializeEntry(raw: SerializedEditEntry): EditEntry {
  const p = raw.payload as Record<string, unknown>
  let operation: EditOperation

  switch (raw.operation) {
    case 'deleteBySelection': {
      const masks = (p.masks as Array<{ tileId: string, mask: number[] }>).map(m => ({
        tileId: m.tileId,
        mask: new Uint8Array(m.mask),
      }))
      operation = { type: 'deleteBySelection', masks }
      break
    }
    case 'keepByAABB':
      operation = { type: 'keepByAABB', bounds: p.bounds as Bounds }
      break
    case 'filterByClassification':
      operation = { type: 'filterByClassification', classes: p.classes as number[] }
      break
    case 'filterByRange':
      operation = {
        type: 'filterByRange',
        attribute: p.attribute as string,
        min: p.min as number,
        max: p.max as number,
      }
      break
    default:
      throw new Error(`Unknown operation type: ${raw.operation}`)
  }

  return {
    id: raw.id,
    operation,
    affectedTileIds: raw.affectedTileIds,
    cameraState: raw.cameraState,
    timestamp: raw.timestamp,
  }
}
