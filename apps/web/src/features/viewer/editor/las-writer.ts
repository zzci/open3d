/**
 * LAS 1.4 binary writer for export.
 *
 * Generates a valid LAS 1.4 file header and encodes point records
 * in the same point format as the source dataset.
 */

import type { Bounds, DatasetDescriptor } from '../data/types'

// LAS 1.4 public header is 375 bytes
const LAS_14_HEADER_SIZE = 375

const POINT_RECORD_BASE_SIZES: Record<number, number> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  6: 30,
  7: 36,
}

/**
 * Build a LAS 1.4 file header as an ArrayBuffer.
 *
 * The header fields are filled from the source descriptor, with updated
 * point count and bounds from the filtered export.
 */
export function buildLasHeader(opts: {
  descriptor: DatasetDescriptor
  pointCount: number
  bounds: Bounds
}): ArrayBuffer {
  const { descriptor, pointCount, bounds } = opts
  const pointFormat = descriptor.pointFormat
  const pointRecordLength = POINT_RECORD_BASE_SIZES[pointFormat] ?? 20

  const buf = new ArrayBuffer(LAS_14_HEADER_SIZE)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // Magic "LASF"
  bytes[0] = 0x4C // L
  bytes[1] = 0x41 // A
  bytes[2] = 0x53 // S
  bytes[3] = 0x46 // F

  // File source ID (0)
  view.setUint16(4, 0, true)
  // Global encoding (GPS time type = 1 for LAS 1.4)
  view.setUint16(6, 1, true)

  // GUID (16 bytes at offset 8) — zeroed

  // Version 1.4
  view.setUint8(24, 1) // major
  view.setUint8(25, 4) // minor

  // System identifier (32 bytes at offset 26) — "Open3D Export"
  const sysId = 'Open3D Export'
  for (let i = 0; i < sysId.length; i++) {
    bytes[26 + i] = sysId.charCodeAt(i)
  }

  // Generating software (32 bytes at offset 58) — "open3d-web"
  const genSw = 'open3d-web'
  for (let i = 0; i < genSw.length; i++) {
    bytes[58 + i] = genSw.charCodeAt(i)
  }

  // File creation day of year + year
  const now = new Date()
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86_400_000) + 1
  view.setUint16(90, dayOfYear, true)
  view.setUint16(92, now.getFullYear(), true)

  // Header size
  view.setUint16(94, LAS_14_HEADER_SIZE, true)

  // Offset to point data (no VLRs for now)
  view.setUint32(96, LAS_14_HEADER_SIZE, true)

  // Number of VLRs
  view.setUint32(100, 0, true)

  // Point data record format (no compression bit)
  view.setUint8(104, pointFormat)

  // Point data record length
  view.setUint16(105, pointRecordLength, true)

  // Legacy number of point records (LAS 1.4 uses 64-bit field, set legacy to 0)
  view.setUint32(107, 0, true)

  // Legacy number of points by return (5 × uint32 at offset 111) — zeroed

  // Scale factors
  view.setFloat64(131, descriptor.scale[0], true)
  view.setFloat64(139, descriptor.scale[1], true)
  view.setFloat64(147, descriptor.scale[2], true)

  // Offsets
  view.setFloat64(155, descriptor.offset[0], true)
  view.setFloat64(163, descriptor.offset[1], true)
  view.setFloat64(171, descriptor.offset[2], true)

  // Bounds: max X, min X, max Y, min Y, max Z, min Z
  view.setFloat64(179, bounds.max[0], true)
  view.setFloat64(187, bounds.min[0], true)
  view.setFloat64(195, bounds.max[1], true)
  view.setFloat64(203, bounds.min[1], true)
  view.setFloat64(211, bounds.max[2], true)
  view.setFloat64(219, bounds.min[2], true)

  // Start of waveform data packet record (uint64 at 227) — 0
  // Start of first extended VLR (uint64 at 235) — 0
  // Number of extended VLRs (uint32 at 243) — 0

  // Number of point records (uint64 at 247)
  view.setUint32(247, pointCount & 0xFFFFFFFF, true)
  view.setUint32(251, Math.floor(pointCount / 0x1_0000_0000), true)

  // Number of points by return (15 × uint64 at 255) — zeroed

  return buf
}

/**
 * Encode a single point record into the provided DataView at the given offset.
 *
 * The caller provides world-space coordinates; this function applies inverse
 * scale/offset to produce the integer X/Y/Z stored in LAS.
 */
export function encodePointRecord(
  view: DataView,
  offset: number,
  format: number,
  scale: [number, number, number],
  fileOffset: [number, number, number],
  point: {
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
  },
): void {
  // Integer coordinates
  const xi = Math.round((point.x - fileOffset[0]) / scale[0])
  const yi = Math.round((point.y - fileOffset[1]) / scale[1])
  const zi = Math.round((point.z - fileOffset[2]) / scale[2])

  view.setInt32(offset, xi, true)
  view.setInt32(offset + 4, yi, true)
  view.setInt32(offset + 8, zi, true)
  view.setUint16(offset + 12, point.intensity, true)

  if (format <= 5) {
    // Legacy formats 0-3
    view.setUint8(offset + 14, point.returnNumber & 0x07)
    view.setUint8(offset + 15, point.classification)

    switch (format) {
      case 1:
        view.setFloat64(offset + 20, point.gpsTime ?? 0, true)
        break
      case 2:
        view.setUint16(offset + 20, point.red ?? 0, true)
        view.setUint16(offset + 22, point.green ?? 0, true)
        view.setUint16(offset + 24, point.blue ?? 0, true)
        break
      case 3:
        view.setFloat64(offset + 20, point.gpsTime ?? 0, true)
        view.setUint16(offset + 28, point.red ?? 0, true)
        view.setUint16(offset + 30, point.green ?? 0, true)
        view.setUint16(offset + 32, point.blue ?? 0, true)
        break
    }
  }
  else {
    // LAS 1.4 formats 6-7
    view.setUint8(offset + 14, point.returnNumber & 0x0F)
    view.setUint8(offset + 16, point.classification)
    view.setFloat64(offset + 22, point.gpsTime ?? 0, true)

    if (format === 7) {
      view.setUint16(offset + 30, point.red ?? 0, true)
      view.setUint16(offset + 32, point.green ?? 0, true)
      view.setUint16(offset + 34, point.blue ?? 0, true)
    }
  }
}

export function getPointRecordSize(format: number): number {
  return POINT_RECORD_BASE_SIZES[format] ?? 20
}

export { LAS_14_HEADER_SIZE }
