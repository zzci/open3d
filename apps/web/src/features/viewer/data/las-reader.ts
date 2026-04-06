import type { Bounds, TileData } from './types'
import { LAS_MAGIC, POINT_FORMAT_ATTRIBUTES } from './types'

const TRAILING_NULLS = /\0+$/

// ---------------------------------------------------------------------------
// LAS header & VLR types
// ---------------------------------------------------------------------------

export interface LasHeader {
  versionMajor: number
  versionMinor: number
  headerSize: number
  offsetToPointData: number
  numVlrs: number
  pointFormat: number
  pointRecordLength: number
  pointCount: number
  scale: [number, number, number]
  offset: [number, number, number]
  bounds: Bounds
  isLaz: boolean
}

export interface VlrRecord {
  userId: string
  recordId: number
  contentLength: number
  data: Uint8Array
}

export interface LasParseResult {
  header: LasHeader
  vlrs: VlrRecord[]
  crs: string | undefined
}

export interface ChunkReaderOptions {
  chunkSize?: number
}

const DEFAULT_CHUNK_SIZE = 100_000

// ---------------------------------------------------------------------------
// Point data record sizes per format (without extra bytes)
// ---------------------------------------------------------------------------

const POINT_RECORD_BASE_SIZES: Record<number, number> = {
  0: 20,
  1: 28,
  2: 26,
  3: 34,
  6: 30,
  7: 36,
  8: 38,
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function sliceFile(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer()
}

function decodeAscii(buffer: ArrayBuffer, offset: number, length: number): string {
  const bytes = new Uint8Array(buffer, offset, length)
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0)
      break
    result += String.fromCharCode(bytes[i]!)
  }
  return result
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export async function parseLasHeader(file: File): Promise<LasHeader> {
  const buf = await sliceFile(file, 0, 375)
  const view = new DataView(buf)

  const magic = decodeAscii(buf, 0, 4)
  if (magic !== LAS_MAGIC) {
    throw new Error(`Not a LAS file: invalid magic "${magic}"`)
  }

  const versionMajor = view.getUint8(24)
  const versionMinor = view.getUint8(25)

  if (versionMajor !== 1 || versionMinor < 2 || versionMinor > 4) {
    throw new Error(
      `Unsupported LAS version ${versionMajor}.${versionMinor} (supported: 1.2-1.4)`,
    )
  }

  const headerSize = view.getUint16(94, true)
  const offsetToPointData = view.getUint32(96, true)
  const numVlrs = view.getUint32(100, true)
  const pointFormatRaw = view.getUint8(104)
  const pointRecordLength = view.getUint16(105, true)

  // Bit 7 of point format indicates compression in LAS 1.4
  const isLaz14 = versionMinor >= 4 && (pointFormatRaw & 0x80) !== 0
  const pointFormat = pointFormatRaw & 0x3F

  // Point count: LAS 1.4 uses 64-bit field at offset 247
  let pointCount: number
  if (versionMajor === 1 && versionMinor >= 4) {
    const lo = view.getUint32(247, true)
    const hi = view.getUint32(251, true)
    pointCount = hi * 0x1_0000_0000 + lo
  }
  else {
    pointCount = view.getUint32(107, true)
  }

  const scale: [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ]

  const offset: [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ]

  const bounds: Bounds = {
    min: [
      view.getFloat64(187, true),
      view.getFloat64(203, true),
      view.getFloat64(219, true),
    ],
    max: [
      view.getFloat64(179, true),
      view.getFloat64(195, true),
      view.getFloat64(211, true),
    ],
  }

  return {
    versionMajor,
    versionMinor,
    headerSize,
    offsetToPointData,
    numVlrs,
    pointFormat,
    pointRecordLength,
    pointCount,
    scale,
    offset,
    bounds,
    isLaz: isLaz14,
  }
}

// ---------------------------------------------------------------------------
// VLR parsing
// ---------------------------------------------------------------------------

export async function parseVlrs(
  file: File,
  header: LasHeader,
): Promise<{ vlrs: VlrRecord[], crs: string | undefined, hasLaszip: boolean }> {
  const vlrRegionSize = header.offsetToPointData - header.headerSize
  if (vlrRegionSize <= 0 || header.numVlrs === 0) {
    return { vlrs: [], crs: undefined, hasLaszip: false }
  }

  const buf = await sliceFile(file, header.headerSize, vlrRegionSize)
  const view = new DataView(buf)
  const vlrs: VlrRecord[] = []
  let crs: string | undefined
  let hasLaszip = false
  let pos = 0

  for (let i = 0; i < header.numVlrs && pos < buf.byteLength - 54; i++) {
    const userId = decodeAscii(buf, pos + 2, 16).trim()
    const recordId = view.getUint16(pos + 18, true)
    const contentLength = view.getUint16(pos + 20, true)
    const data = new Uint8Array(buf, pos + 54, contentLength)

    vlrs.push({ userId, recordId, contentLength, data })

    if (userId === 'laszip encoded' && recordId === 22204) {
      hasLaszip = true
    }

    if (userId === 'LASF_Projection' && recordId === 2112) {
      crs = new TextDecoder().decode(data).replace(TRAILING_NULLS, '')
    }

    pos += 54 + contentLength
  }

  return { vlrs, crs, hasLaszip }
}

// ---------------------------------------------------------------------------
// Full parse convenience
// ---------------------------------------------------------------------------

export async function parseLas(file: File): Promise<LasParseResult> {
  const header = await parseLasHeader(file)
  const { vlrs, crs, hasLaszip } = await parseVlrs(file, header)

  // Merge LAZ detection from VLR scan with header flag
  const mergedHeader: LasHeader = {
    ...header,
    isLaz: header.isLaz || hasLaszip,
  }

  return { header: mergedHeader, vlrs, crs }
}

// ---------------------------------------------------------------------------
// Point record decoder
// ---------------------------------------------------------------------------

interface DecodedPoint {
  x: number
  y: number
  z: number
  intensity: number
  returnNumber: number
  numberOfReturns: number
  classification: number
  scanAngle: number
  userData: number
  pointSourceId: number
  classificationFlags: number
  scannerChannel: number
  gpsTime?: number
  red?: number
  green?: number
  blue?: number
  nir?: number
}

function decodePointRecord(
  view: DataView,
  offset: number,
  format: number,
  scale: [number, number, number],
  fileOffset: [number, number, number],
): DecodedPoint {
  const xi = view.getInt32(offset, true)
  const yi = view.getInt32(offset + 4, true)
  const zi = view.getInt32(offset + 8, true)

  const x = xi * scale[0] + fileOffset[0]
  const y = yi * scale[1] + fileOffset[1]
  const z = zi * scale[2] + fileOffset[2]

  const intensity = view.getUint16(offset + 12, true)

  let returnNumber: number
  let numberOfReturns: number
  let classification: number
  let scanAngle: number
  let userData: number
  let pointSourceId: number
  let classificationFlags = 0
  let scannerChannel = 0
  let gpsTime: number | undefined
  let red: number | undefined
  let green: number | undefined
  let blue: number | undefined
  let nir: number | undefined

  if (format <= 5) {
    // Legacy formats 0-5 (LAS 1.2-1.3)
    // Byte 14: Return Number (bits 0-2), Number of Returns (bits 3-5),
    //          Scan Direction Flag (bit 6), Edge of Flight Line (bit 7)
    const flagByte = view.getUint8(offset + 14)
    returnNumber = flagByte & 0x07
    numberOfReturns = (flagByte >> 3) & 0x07
    classification = view.getUint8(offset + 15)
    // Byte 16: Scan Angle Rank (Int8, -90 to +90 degrees)
    scanAngle = view.getInt8(offset + 16)
    // Byte 17: User Data
    userData = view.getUint8(offset + 17)
    // Bytes 18-19: Point Source ID
    pointSourceId = view.getUint16(offset + 18, true)

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
    // LAS 1.4 formats 6-8
    // Byte 14: Return Number (bits 0-3), Number of Returns (bits 4-7)
    const flagByte = view.getUint8(offset + 14)
    returnNumber = flagByte & 0x0F
    numberOfReturns = (flagByte >> 4) & 0x0F
    // Byte 15: Classification Flags (bits 0-3), Scanner Channel (bits 4-5),
    //          Scan Direction Flag (bit 6), Edge of Flight Line (bit 7)
    const flagByte2 = view.getUint8(offset + 15)
    classificationFlags = flagByte2 & 0x0F
    scannerChannel = (flagByte2 >> 4) & 0x03
    classification = view.getUint8(offset + 16)
    // Byte 17: User Data
    userData = view.getUint8(offset + 17)
    // Bytes 18-19: Scan Angle (Int16, scaled by 0.006 degrees)
    scanAngle = view.getInt16(offset + 18, true) * 0.006
    // Bytes 20-21: Point Source ID
    pointSourceId = view.getUint16(offset + 20, true)
    gpsTime = view.getFloat64(offset + 22, true)

    if (format >= 7) {
      red = view.getUint16(offset + 30, true)
      green = view.getUint16(offset + 32, true)
      blue = view.getUint16(offset + 34, true)
    }

    if (format >= 8) {
      nir = view.getUint16(offset + 36, true)
    }
  }

  return {
    x,
    y,
    z,
    intensity,
    returnNumber,
    numberOfReturns,
    classification,
    scanAngle,
    userData,
    pointSourceId,
    classificationFlags,
    scannerChannel,
    gpsTime,
    red,
    green,
    blue,
    nir,
  }
}

// ---------------------------------------------------------------------------
// Helpers: check if format has color / attributes lookup
// ---------------------------------------------------------------------------

function formatHasColor(format: number): boolean {
  return format === 2 || format === 3 || format === 7 || format === 8
}

function getFormatAttributes(format: number): string[] {
  const baseFormat = format > 127 ? format - 128 : format
  return POINT_FORMAT_ATTRIBUTES[baseFormat] ?? POINT_FORMAT_ATTRIBUTES[0]!
}

// ---------------------------------------------------------------------------
// Build TileData from decoded points
// ---------------------------------------------------------------------------

function buildTileData(
  points: DecodedPoint[],
  chunkIndex: number,
  hasColor: boolean,
  totalBounds: Bounds,
  pointFormat: number,
): TileData {
  const count = points.length
  const positions = new Float32Array(count * 3)
  const colors = hasColor ? new Uint8Array(count * 3) : undefined
  const intensity = new Float32Array(count)
  const classification = new Uint8Array(count)
  const returnNumber = new Uint8Array(count)
  const numberOfReturns = new Uint8Array(count)
  const scanAngle = new Float32Array(count)
  const userData = new Uint8Array(count)
  const pointSourceId = new Uint16Array(count)
  const hasGpsTime = pointFormat === 1 || pointFormat === 3 || pointFormat >= 6
  const gpsTime = hasGpsTime ? new Float64Array(count) : undefined
  const hasNir = pointFormat === 8
  const nirArray = hasNir ? new Uint16Array(count) : undefined
  const hasFlags14 = pointFormat >= 6
  const classificationFlags = hasFlags14 ? new Uint8Array(count) : undefined
  const scannerChannel = hasFlags14 ? new Uint8Array(count) : undefined

  for (let i = 0; i < count; i++) {
    const p = points[i]!
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    // Normalize intensity from 16-bit to 0-1
    intensity[i] = p.intensity / 65535
    classification[i] = p.classification
    returnNumber[i] = p.returnNumber
    numberOfReturns[i] = p.numberOfReturns
    scanAngle[i] = p.scanAngle
    userData[i] = p.userData
    pointSourceId[i] = p.pointSourceId

    if (gpsTime && p.gpsTime !== undefined) {
      gpsTime[i] = p.gpsTime
    }

    if (colors && p.red !== undefined && p.green !== undefined && p.blue !== undefined) {
      // LAS stores 16-bit color, scale to 8-bit
      colors[i * 3] = p.red >> 8
      colors[i * 3 + 1] = p.green >> 8
      colors[i * 3 + 2] = p.blue >> 8
    }

    if (nirArray && p.nir !== undefined) {
      nirArray[i] = p.nir
    }

    if (classificationFlags) {
      classificationFlags[i] = p.classificationFlags
    }
    if (scannerChannel) {
      scannerChannel[i] = p.scannerChannel
    }
  }

  return {
    nodeId: `chunk-${chunkIndex}`,
    level: 0,
    pointCount: count,
    bounds: totalBounds,
    positions,
    colors,
    intensity,
    classification,
    returnNumber,
    numberOfReturns,
    scanAngle,
    userData,
    pointSourceId,
    gpsTime,
    nir: nirArray,
    classificationFlags,
    scannerChannel,
  }
}

// ---------------------------------------------------------------------------
// LAS (uncompressed) chunk reader
// ---------------------------------------------------------------------------

export async function* readLasChunks(
  file: File,
  header: LasHeader,
  options?: ChunkReaderOptions,
): AsyncGenerator<TileData> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE
  const { pointCount, pointRecordLength, offsetToPointData, pointFormat, scale, offset, bounds } = header
  const hasColor = formatHasColor(pointFormat)

  let remaining = pointCount
  let filePos = offsetToPointData
  let chunkIndex = 0

  while (remaining > 0) {
    const batchCount = Math.min(chunkSize, remaining)
    const batchBytes = batchCount * pointRecordLength
    const buf = await sliceFile(file, filePos, batchBytes)
    const view = new DataView(buf)

    const points: DecodedPoint[] = []
    for (let i = 0; i < batchCount; i++) {
      points.push(
        decodePointRecord(view, i * pointRecordLength, pointFormat, scale, offset),
      )
    }

    yield buildTileData(points, chunkIndex, hasColor, bounds, pointFormat)

    filePos += batchBytes
    remaining -= batchCount
    chunkIndex++
  }
}

// ---------------------------------------------------------------------------
// LAZ (compressed) chunk reader via laz-perf
// ---------------------------------------------------------------------------

interface LazPerfModule {
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  HEAPU8: Uint8Array
  LASZip: new () => {
    delete: () => void
    open: (data: number, length: number) => void
    getPoint: (dest: number) => void
    getCount: () => number
    getPointLength: () => number
  }
}

async function initLazPerf(): Promise<LazPerfModule> {
  const { create } = await import('laz-perf')
  return (await create()) as unknown as LazPerfModule
}

export async function* readLazChunks(
  file: File,
  header: LasHeader,
  options?: ChunkReaderOptions,
): AsyncGenerator<TileData> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE
  const { pointCount, pointRecordLength, offsetToPointData, pointFormat, scale, offset, bounds } = header
  const hasColor = formatHasColor(pointFormat)

  const lp = await initLazPerf()

  // Read the entire compressed point data region
  const compressedSize = file.size - offsetToPointData
  const compressedBuf = await sliceFile(file, offsetToPointData, compressedSize)
  const compressedBytes = new Uint8Array(compressedBuf)

  // Allocate WASM memory for compressed input
  const srcPtr = lp._malloc(compressedBytes.length)
  lp.HEAPU8.set(compressedBytes, srcPtr)

  // Allocate buffer for one decompressed point
  const pointPtr = lp._malloc(pointRecordLength)

  const decoder = new lp.LASZip()
  try {
    decoder.open(srcPtr, compressedBytes.length)

    let remaining = pointCount
    let chunkIndex = 0

    while (remaining > 0) {
      const batchCount = Math.min(chunkSize, remaining)
      const points: DecodedPoint[] = []

      for (let i = 0; i < batchCount; i++) {
        decoder.getPoint(pointPtr)

        // Copy decompressed point bytes into a DataView
        const pointBytes = lp.HEAPU8.slice(pointPtr, pointPtr + pointRecordLength)
        const view = new DataView(pointBytes.buffer)

        points.push(
          decodePointRecord(view, 0, pointFormat, scale, offset),
        )
      }

      yield buildTileData(points, chunkIndex, hasColor, bounds, pointFormat)

      remaining -= batchCount
      chunkIndex++
    }
  }
  finally {
    decoder.delete()
    lp._free(pointPtr)
    lp._free(srcPtr)
  }
}

// ---------------------------------------------------------------------------
// Unified chunk reader (auto-detects LAS vs LAZ)
// ---------------------------------------------------------------------------

export async function* readChunks(
  file: File,
  header: LasHeader,
  options?: ChunkReaderOptions,
): AsyncGenerator<TileData> {
  if (header.isLaz) {
    yield* readLazChunks(file, header, options)
  }
  else {
    yield* readLasChunks(file, header, options)
  }
}

// ---------------------------------------------------------------------------
// Exports for external use
// ---------------------------------------------------------------------------

export {
  DEFAULT_CHUNK_SIZE,
  formatHasColor,
  getFormatAttributes,
  POINT_RECORD_BASE_SIZES,
}

export type { DecodedPoint }
