/**
 * Export Worker — streaming LAS 1.4 export.
 *
 * Two-pass approach:
 *   Pass 1 ("counting"): read source points, apply edit log → count survivors + compute bounds
 *   Pass 2 ("writing"):  write LAS header + filtered points in 1 MB chunks to OPFS temp file
 *
 * Never builds a single giant Blob — all writes go directly to OPFS.
 */

import type { Bounds, DatasetDescriptor, WorkerRequest, WorkerResponse } from '../data/types'
import type { EditLogEntry } from '../editor/edit-log-types'
import { buildLasHeader, encodePointRecord, getPointRecordSize, LAS_14_HEADER_SIZE } from '../editor/las-writer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportPayload {
  file: File
  descriptor: DatasetDescriptor
  editLog: EditLogEntry[]
}

export interface ExportProgress {
  phase: 'counting' | 'writing' | 'finalizing'
  pointsProcessed: number
  totalPoints: number
  bytesWritten: number
}

export interface ExportResult {
  tempFileName: string
  pointCount: number
  fileSize: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cancellation state — wrapped in object so the reference is stable across async yields */
const state = { cancelled: false }

function respond(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    globalThis.postMessage(msg, { transfer })
  }
  else {
    globalThis.postMessage(msg)
  }
}

function progress(requestId: string, data: ExportProgress): void {
  respond({
    requestId,
    type: 'progress',
    payload: data,
  })
}

function sliceFile(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer()
}

// ---------------------------------------------------------------------------
// Point record decoder (minimal — extracts fields needed for filtering + re-encoding)
// ---------------------------------------------------------------------------

interface RawPoint {
  x: number
  y: number
  z: number
  intensity: number
  returnNumber: number
  classification: number
  gpsTime?: number
  red?: number
  green?: number
  blue?: number
}

function decodePoint(
  view: DataView,
  offset: number,
  format: number,
  scale: [number, number, number],
  fileOffset: [number, number, number],
): RawPoint {
  const xi = view.getInt32(offset, true)
  const yi = view.getInt32(offset + 4, true)
  const zi = view.getInt32(offset + 8, true)

  const x = xi * scale[0] + fileOffset[0]
  const y = yi * scale[1] + fileOffset[1]
  const z = zi * scale[2] + fileOffset[2]

  const intensity = view.getUint16(offset + 12, true)

  let returnNumber: number
  let classification: number
  let gpsTime: number | undefined
  let red: number | undefined
  let green: number | undefined
  let blue: number | undefined

  if (format <= 5) {
    const flagByte = view.getUint8(offset + 14)
    returnNumber = flagByte & 0x07
    classification = view.getUint8(offset + 15)

    switch (format) {
      case 1:
        gpsTime = view.getFloat64(offset + 20, true)
        break
      case 2:
        red = view.getUint16(offset + 20, true)
        green = view.getUint16(offset + 22, true)
        blue = view.getUint16(offset + 24, true)
        break
      case 3:
        gpsTime = view.getFloat64(offset + 20, true)
        red = view.getUint16(offset + 28, true)
        green = view.getUint16(offset + 30, true)
        blue = view.getUint16(offset + 32, true)
        break
    }
  }
  else {
    const flagByte = view.getUint8(offset + 14)
    returnNumber = flagByte & 0x0F
    classification = view.getUint8(offset + 16)
    gpsTime = view.getFloat64(offset + 22, true)

    if (format === 7) {
      red = view.getUint16(offset + 30, true)
      green = view.getUint16(offset + 32, true)
      blue = view.getUint16(offset + 34, true)
    }
  }

  return { x, y, z, intensity, returnNumber, classification, gpsTime, red, green, blue }
}

// ---------------------------------------------------------------------------
// Edit log filter
// ---------------------------------------------------------------------------

function pointPassesLog(
  entries: readonly EditLogEntry[],
  point: RawPoint,
): boolean {
  for (const entry of entries) {
    switch (entry.type) {
      case 'deleteBySelection':
        // Selection-based deletion requires per-point index masks.
        // During sequential file scan we don't have node/point indices,
        // so this operation type is skipped in raw-file export mode.
        break
      case 'keepByAABB': {
        const b = (entry.params as { bounds: Bounds }).bounds
        if (
          point.x < b.min[0] || point.x > b.max[0]
          || point.y < b.min[1] || point.y > b.max[1]
          || point.z < b.min[2] || point.z > b.max[2]
        ) {
          return false
        }
        break
      }
      case 'filterByClassification': {
        const keep = (entry.params as { keep: number[] }).keep
        if (!keep.includes(point.classification))
          return false
        break
      }
      case 'filterByRange': {
        const p = entry.params as { attribute: string, min: number, max: number }
        const value = p.attribute === 'z' ? point.z : point.intensity / 65535
        if (value < p.min || value > p.max)
          return false
        break
      }
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// OPFS temp file helpers
// ---------------------------------------------------------------------------

async function getExportTempDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const cacheDir = await root.getDirectoryHandle('cache', { create: true })
  return cacheDir.getDirectoryHandle('export-tmp', { create: true })
}

async function createTempFile(name: string): Promise<FileSystemFileHandle> {
  const dir = await getExportTempDir()
  return dir.getFileHandle(name, { create: true })
}

export async function deleteTempFile(name: string): Promise<void> {
  try {
    const dir = await getExportTempDir()
    await dir.removeEntry(name)
  }
  catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// Chunk size constants
// ---------------------------------------------------------------------------

const SOURCE_CHUNK_POINTS = 100_000
const WRITE_BUFFER_SIZE = 1_048_576 // 1 MB

// ---------------------------------------------------------------------------
// Pass 1: count surviving points + compute bounds
// ---------------------------------------------------------------------------

async function countPass(
  requestId: string,
  file: File,
  descriptor: DatasetDescriptor,
  editLog: readonly EditLogEntry[],
): Promise<{ survivorCount: number, bounds: Bounds }> {
  const { pointCount, pointFormat, pointRecordLength, offsetToPointData, scale, offset } = descriptor as DatasetDescriptor & { pointRecordLength: number, offsetToPointData: number }

  let survivorCount = 0
  const minB: [number, number, number] = [Infinity, Infinity, Infinity]
  const maxB: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  let remaining = pointCount
  let filePos = offsetToPointData
  let processed = 0

  while (remaining > 0 && !state.cancelled) {
    const batch = Math.min(SOURCE_CHUNK_POINTS, remaining)
    const buf = await sliceFile(file, filePos, batch * pointRecordLength)
    const view = new DataView(buf)

    for (let i = 0; i < batch; i++) {
      const pt = decodePoint(view, i * pointRecordLength, pointFormat, scale, offset)

      if (editLog.length === 0 || pointPassesLog(editLog, pt)) {
        survivorCount++
        if (pt.x < minB[0])
          minB[0] = pt.x
        if (pt.y < minB[1])
          minB[1] = pt.y
        if (pt.z < minB[2])
          minB[2] = pt.z
        if (pt.x > maxB[0])
          maxB[0] = pt.x
        if (pt.y > maxB[1])
          maxB[1] = pt.y
        if (pt.z > maxB[2])
          maxB[2] = pt.z
      }
    }

    filePos += batch * pointRecordLength
    remaining -= batch
    processed += batch

    progress(requestId, {
      phase: 'counting',
      pointsProcessed: processed,
      totalPoints: pointCount,
      bytesWritten: 0,
    })
  }

  // Handle edge case: no survivors
  if (survivorCount === 0) {
    return {
      survivorCount: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    }
  }

  return {
    survivorCount,
    bounds: { min: minB, max: maxB },
  }
}

// ---------------------------------------------------------------------------
// Pass 2: write LAS header + filtered points
// ---------------------------------------------------------------------------

async function writePass(
  requestId: string,
  file: File,
  descriptor: DatasetDescriptor,
  editLog: readonly EditLogEntry[],
  survivorCount: number,
  bounds: Bounds,
  tempFileName: string,
): Promise<number> {
  const { pointCount, pointFormat, pointRecordLength, offsetToPointData, scale, offset } = descriptor as DatasetDescriptor & { pointRecordLength: number, offsetToPointData: number }

  const outRecordSize = getPointRecordSize(pointFormat)

  // Build header
  const headerBuf = buildLasHeader({ descriptor, pointCount: survivorCount, bounds })

  // Open OPFS writable stream
  const fileHandle = await createTempFile(tempFileName)
  const writable = await fileHandle.createWritable()

  // Write header
  await writable.write(headerBuf)
  let bytesWritten = LAS_14_HEADER_SIZE

  // Allocate write buffer (1 MB)
  const writeBuf = new ArrayBuffer(WRITE_BUFFER_SIZE)
  const writeView = new DataView(writeBuf)
  let bufferOffset = 0

  async function flushBuffer(): Promise<void> {
    if (bufferOffset > 0) {
      await writable.write(new Uint8Array(writeBuf, 0, bufferOffset))
      bytesWritten += bufferOffset
      bufferOffset = 0
    }
  }

  let remaining = pointCount
  let filePos = offsetToPointData
  let pointsWritten = 0

  while (remaining > 0 && !state.cancelled) {
    const batch = Math.min(SOURCE_CHUNK_POINTS, remaining)
    const buf = await sliceFile(file, filePos, batch * pointRecordLength)
    const view = new DataView(buf)

    for (let i = 0; i < batch; i++) {
      const pt = decodePoint(view, i * pointRecordLength, pointFormat, scale, offset)

      if (editLog.length === 0 || pointPassesLog(editLog, pt)) {
        // Ensure buffer has space for one record
        if (bufferOffset + outRecordSize > WRITE_BUFFER_SIZE) {
          await flushBuffer()
        }

        encodePointRecord(writeView, bufferOffset, pointFormat, scale, offset, pt)
        bufferOffset += outRecordSize
        pointsWritten++
      }
    }

    filePos += batch * pointRecordLength
    remaining -= batch

    progress(requestId, {
      phase: 'writing',
      pointsProcessed: pointsWritten,
      totalPoints: survivorCount,
      bytesWritten,
    })
  }

  // Flush remaining buffer
  await flushBuffer()

  // Finalize
  progress(requestId, {
    phase: 'finalizing',
    pointsProcessed: pointsWritten,
    totalPoints: survivorCount,
    bytesWritten,
  })

  await writable.close()
  return bytesWritten
}

// ---------------------------------------------------------------------------
// Main export handler
// ---------------------------------------------------------------------------

async function handleExport(requestId: string, payload: ExportPayload): Promise<void> {
  state.cancelled = false
  const { file, descriptor, editLog } = payload

  // We need pointRecordLength and offsetToPointData from the descriptor.
  // The descriptor doesn't carry these directly — re-parse the header.
  const headerBuf = await sliceFile(file, 0, 375)
  const hView = new DataView(headerBuf)
  const offsetToPointData = hView.getUint32(96, true)
  const pointRecordLength = hView.getUint16(105, true)

  // Augment descriptor for internal use
  const augmented = { ...descriptor, pointRecordLength, offsetToPointData }

  // Pass 1: count
  const { survivorCount, bounds } = await countPass(requestId, file, augmented, editLog)

  if (state.cancelled) {
    respond({ requestId, type: 'error', payload: { message: 'Export cancelled' } })
    return
  }

  if (survivorCount === 0) {
    respond({ requestId, type: 'error', payload: { message: 'No points pass the current filters' } })
    return
  }

  // Pass 2: write
  const tempFileName = `export-${Date.now()}.las`
  const fileSize = await writePass(requestId, file, augmented, editLog, survivorCount, bounds, tempFileName)

  if (state.cancelled) {
    await deleteTempFile(tempFileName)
    respond({ requestId, type: 'error', payload: { message: 'Export cancelled' } })
    return
  }

  const result: ExportResult = {
    tempFileName,
    pointCount: survivorCount,
    fileSize,
  }

  respond({ requestId, type: 'result', payload: result })
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

globalThis.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload } = event.data

  switch (type) {
    case 'export':
      handleExport(requestId, payload as ExportPayload).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Export failed'
        respond({ requestId, type: 'error', payload: { message } })
      })
      break

    case 'cancel':
      state.cancelled = true
      break
  }
})
