import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHUNK_SIZE,
  formatHasColor,
  getFormatAttributes,
  parseLas,
  parseLasHeader,
  parseVlrs,
  POINT_RECORD_BASE_SIZES,
  readLasChunks,
} from './las-reader'

// ---------------------------------------------------------------------------
// Helpers: build synthetic LAS binary data
// ---------------------------------------------------------------------------

function writeLasHeader(opts: {
  versionMinor?: number
  pointFormat?: number
  pointRecordLength?: number
  pointCount?: number
  numVlrs?: number
  headerSize?: number
  offsetToPointData?: number
  scale?: [number, number, number]
  offset?: [number, number, number]
  bounds?: { min: [number, number, number], max: [number, number, number] }
}): ArrayBuffer {
  const minor = opts.versionMinor ?? 2
  const format = opts.pointFormat ?? 0
  const recLen = opts.pointRecordLength ?? POINT_RECORD_BASE_SIZES[format] ?? 20
  const count = opts.pointCount ?? 0
  const numVlrs = opts.numVlrs ?? 0
  const headerSize = opts.headerSize ?? (minor >= 4 ? 375 : 227)
  const offsetToPointData = opts.offsetToPointData ?? headerSize
  const scale = opts.scale ?? [0.001, 0.001, 0.001]
  const offset = opts.offset ?? [0, 0, 0]
  const bounds = opts.bounds ?? { min: [0, 0, 0], max: [10, 10, 10] }

  // Allocate enough for the largest header (LAS 1.4 = 375 bytes)
  const buf = new ArrayBuffer(375)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // Magic "LASF"
  bytes[0] = 0x4C // L
  bytes[1] = 0x41 // A
  bytes[2] = 0x53 // S
  bytes[3] = 0x46 // F

  // Version
  view.setUint8(24, 1)
  view.setUint8(25, minor)

  // Header size
  view.setUint16(94, headerSize, true)

  // Offset to point data
  view.setUint32(96, offsetToPointData, true)

  // Number of VLRs
  view.setUint32(100, numVlrs, true)

  // Point format
  view.setUint8(104, format)

  // Point record length
  view.setUint16(105, recLen, true)

  // Legacy point count (LAS 1.2-1.3)
  if (minor < 4) {
    view.setUint32(107, count, true)
  }

  // Scale
  view.setFloat64(131, scale[0], true)
  view.setFloat64(139, scale[1], true)
  view.setFloat64(147, scale[2], true)

  // Offset
  view.setFloat64(155, offset[0], true)
  view.setFloat64(163, offset[1], true)
  view.setFloat64(171, offset[2], true)

  // Bounds: max then min for each axis
  view.setFloat64(179, bounds.max[0], true)
  view.setFloat64(187, bounds.min[0], true)
  view.setFloat64(195, bounds.max[1], true)
  view.setFloat64(203, bounds.min[1], true)
  view.setFloat64(211, bounds.max[2], true)
  view.setFloat64(219, bounds.min[2], true)

  // LAS 1.4 point count (64-bit at offset 247)
  if (minor >= 4) {
    view.setUint32(247, count, true)
    view.setUint32(251, 0, true)
  }

  return buf
}

function writePointRecord0(
  xi: number,
  yi: number,
  zi: number,
  intensity: number,
  classification: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(20)
  const view = new DataView(buf)
  view.setInt32(0, xi, true)
  view.setInt32(4, yi, true)
  view.setInt32(8, zi, true)
  view.setUint16(12, intensity, true)
  view.setUint8(14, 0) // return number / flags
  view.setUint8(15, classification)
  return buf
}

function writePointRecord2(
  xi: number,
  yi: number,
  zi: number,
  intensity: number,
  classification: number,
  red: number,
  green: number,
  blue: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(26)
  const view = new DataView(buf)
  view.setInt32(0, xi, true)
  view.setInt32(4, yi, true)
  view.setInt32(8, zi, true)
  view.setUint16(12, intensity, true)
  view.setUint8(14, 0)
  view.setUint8(15, classification)
  // Bytes 16-19: scan angle, user data, source id
  view.setUint16(20, red, true)
  view.setUint16(22, green, true)
  view.setUint16(24, blue, true)
  return buf
}

function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const b of buffers) {
    result.set(new Uint8Array(b), offset)
    offset += b.byteLength
  }
  return result.buffer
}

function createFile(buffer: ArrayBuffer, name = 'test.las'): File {
  return new File([buffer], name, { type: 'application/octet-stream' })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseLasHeader', () => {
  it('parses LAS 1.2 header correctly', async () => {
    const headerBuf = writeLasHeader({
      versionMinor: 2,
      pointFormat: 0,
      pointRecordLength: 20,
      pointCount: 1000,
      scale: [0.01, 0.01, 0.01],
      offset: [100, 200, 300],
      bounds: { min: [90, 190, 290], max: [110, 210, 310] },
    })
    const file = createFile(headerBuf)

    const header = await parseLasHeader(file)

    expect(header.versionMajor).toBe(1)
    expect(header.versionMinor).toBe(2)
    expect(header.pointFormat).toBe(0)
    expect(header.pointRecordLength).toBe(20)
    expect(header.pointCount).toBe(1000)
    expect(header.scale).toEqual([0.01, 0.01, 0.01])
    expect(header.offset).toEqual([100, 200, 300])
    expect(header.bounds.min).toEqual([90, 190, 290])
    expect(header.bounds.max).toEqual([110, 210, 310])
    expect(header.isLaz).toBe(false)
  })

  it('parses LAS 1.4 header with 64-bit point count', async () => {
    const headerBuf = writeLasHeader({
      versionMinor: 4,
      pointFormat: 6,
      pointRecordLength: 30,
      pointCount: 5_000_000,
      headerSize: 375,
    })
    const file = createFile(headerBuf)

    const header = await parseLasHeader(file)

    expect(header.versionMinor).toBe(4)
    expect(header.pointFormat).toBe(6)
    expect(header.pointCount).toBe(5_000_000)
  })

  it('detects LAZ compression bit in LAS 1.4 point format', async () => {
    const headerBuf = writeLasHeader({
      versionMinor: 4,
      pointFormat: 6 | 0x80, // compression bit set
      pointRecordLength: 30,
      pointCount: 100,
      headerSize: 375,
    })
    const file = createFile(headerBuf)

    const header = await parseLasHeader(file)

    expect(header.pointFormat).toBe(6) // stripped of compression bit
    expect(header.isLaz).toBe(true)
  })

  it('rejects non-LAS files', async () => {
    const buf = new ArrayBuffer(375)
    const bytes = new Uint8Array(buf)
    bytes[0] = 0x50 // P
    bytes[1] = 0x44 // D
    const file = createFile(buf)

    await expect(parseLasHeader(file)).rejects.toThrow('Not a LAS file')
  })

  it('rejects unsupported LAS versions', async () => {
    const buf = new ArrayBuffer(375)
    const view = new DataView(buf)
    const bytes = new Uint8Array(buf)
    bytes[0] = 0x4C
    bytes[1] = 0x41
    bytes[2] = 0x53
    bytes[3] = 0x46
    view.setUint8(24, 2) // version 2.0
    view.setUint8(25, 0)
    const file = createFile(buf)

    await expect(parseLasHeader(file)).rejects.toThrow('Unsupported LAS version')
  })
})

describe('parseVlrs', () => {
  it('returns empty array when no VLRs', async () => {
    const headerBuf = writeLasHeader({ numVlrs: 0 })
    const file = createFile(headerBuf)
    const header = await parseLasHeader(file)

    const result = await parseVlrs(file, header)

    expect(result.vlrs).toEqual([])
    expect(result.crs).toBeUndefined()
    expect(result.hasLaszip).toBe(false)
  })

  it('detects laszip VLR', async () => {
    const headerSize = 227
    // Build a VLR: reserved(2) + userId(16) + recordId(2) + contentLength(2) + description(32) = 54 header + content
    const vlrBuf = new ArrayBuffer(54 + 10)
    const vlrView = new DataView(vlrBuf)
    const vlrBytes = new Uint8Array(vlrBuf)

    // userId: "laszip encoded\0\0" at offset 2
    const userId = 'laszip encoded'
    for (let i = 0; i < userId.length; i++) {
      vlrBytes[2 + i] = userId.charCodeAt(i)
    }

    // recordId: 22204
    vlrView.setUint16(18, 22204, true)
    // contentLength: 10
    vlrView.setUint16(20, 10, true)

    const headerBuf = writeLasHeader({
      numVlrs: 1,
      headerSize,
      offsetToPointData: headerSize + 64,
    })

    // Trim header to headerSize so VLR starts at the correct offset
    const trimmedHeader = headerBuf.slice(0, headerSize)
    const fileBuf = concatBuffers(trimmedHeader, vlrBuf)
    const file = createFile(fileBuf)
    const header = await parseLasHeader(file)

    const result = await parseVlrs(file, header)

    expect(result.hasLaszip).toBe(true)
    expect(result.vlrs).toHaveLength(1)
    expect(result.vlrs[0]!.userId).toBe('laszip encoded')
    expect(result.vlrs[0]!.recordId).toBe(22204)
  })
})

describe('parseLas', () => {
  it('combines header and VLR parsing', async () => {
    const headerBuf = writeLasHeader({
      versionMinor: 3,
      pointFormat: 3,
      pointRecordLength: 34,
      pointCount: 500,
    })
    const file = createFile(headerBuf)

    const result = await parseLas(file)

    expect(result.header.versionMinor).toBe(3)
    expect(result.header.pointFormat).toBe(3)
    expect(result.header.pointCount).toBe(500)
    expect(result.vlrs).toEqual([])
  })
})

describe('readLasChunks', () => {
  it('reads format 0 points into TileData chunks', async () => {
    const scale: [number, number, number] = [0.001, 0.001, 0.001]
    const offset: [number, number, number] = [0, 0, 0]
    const headerSize = 227
    const pointRecordLength = 20
    const pointCount = 3

    const headerBuf = writeLasHeader({
      versionMinor: 2,
      pointFormat: 0,
      pointRecordLength,
      pointCount,
      headerSize,
      offsetToPointData: headerSize,
      scale,
      offset,
      bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    })

    const point1 = writePointRecord0(1000, 2000, 3000, 100, 2)
    const point2 = writePointRecord0(4000, 5000, 6000, 200, 3)
    const point3 = writePointRecord0(7000, 8000, 9000, 300, 6)

    // Trim header to headerSize and concat with points
    const trimmedHeader = headerBuf.slice(0, headerSize)
    const fileBuf = concatBuffers(trimmedHeader, point1, point2, point3)
    const file = createFile(fileBuf)

    const header = await parseLasHeader(file)
    const chunks: Awaited<ReturnType<typeof readLasChunks> extends AsyncGenerator<infer T> ? T : never>[] = []

    for await (const chunk of readLasChunks(file, header, { chunkSize: 10 })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    const tile = chunks[0]!
    expect(tile.pointCount).toBe(3)
    expect(tile.nodeId).toBe('chunk-0')

    // Check decoded positions: xi * scale + offset
    expect(tile.positions[0]).toBeCloseTo(1.0)
    expect(tile.positions[1]).toBeCloseTo(2.0)
    expect(tile.positions[2]).toBeCloseTo(3.0)

    expect(tile.positions[3]).toBeCloseTo(4.0)
    expect(tile.positions[4]).toBeCloseTo(5.0)
    expect(tile.positions[5]).toBeCloseTo(6.0)

    // Check intensity (normalized 0-1)
    expect(tile.intensity![0]).toBeCloseTo(100 / 65535, 4)

    // Check classification
    expect(tile.classification![0]).toBe(2)
    expect(tile.classification![1]).toBe(3)
    expect(tile.classification![2]).toBe(6)

    // Format 0 has no color
    expect(tile.colors).toBeUndefined()
  })

  it('reads format 2 points with color', async () => {
    const headerSize = 227
    const pointRecordLength = 26

    const headerBuf = writeLasHeader({
      versionMinor: 2,
      pointFormat: 2,
      pointRecordLength,
      pointCount: 1,
      headerSize,
      offsetToPointData: headerSize,
      scale: [0.001, 0.001, 0.001],
      offset: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    })

    const point = writePointRecord2(1000, 2000, 3000, 500, 2, 65535, 32768, 0)

    const trimmedHeader = headerBuf.slice(0, headerSize)
    const fileBuf = concatBuffers(trimmedHeader, point)
    const file = createFile(fileBuf)

    const header = await parseLasHeader(file)
    const chunks = []

    for await (const chunk of readLasChunks(file, header)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    const tile = chunks[0]!
    expect(tile.pointCount).toBe(1)
    expect(tile.colors).toBeDefined()
    // 65535 >> 8 = 255, 32768 >> 8 = 128, 0 >> 8 = 0
    expect(tile.colors![0]).toBe(255)
    expect(tile.colors![1]).toBe(128)
    expect(tile.colors![2]).toBe(0)
  })

  it('splits into multiple chunks when chunkSize < pointCount', async () => {
    const headerSize = 227
    const pointRecordLength = 20
    const pointCount = 5

    const headerBuf = writeLasHeader({
      versionMinor: 2,
      pointFormat: 0,
      pointRecordLength,
      pointCount,
      headerSize,
      offsetToPointData: headerSize,
      scale: [0.001, 0.001, 0.001],
      offset: [0, 0, 0],
    })

    const points: ArrayBuffer[] = []
    for (let i = 0; i < pointCount; i++) {
      points.push(writePointRecord0(i * 1000, i * 1000, i * 1000, i * 100, i))
    }

    const trimmedHeader = headerBuf.slice(0, headerSize)
    const fileBuf = concatBuffers(trimmedHeader, ...points)
    const file = createFile(fileBuf)

    const header = await parseLasHeader(file)
    const chunks = []

    for await (const chunk of readLasChunks(file, header, { chunkSize: 2 })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(3) // 2 + 2 + 1
    expect(chunks[0]!.pointCount).toBe(2)
    expect(chunks[1]!.pointCount).toBe(2)
    expect(chunks[2]!.pointCount).toBe(1)
    expect(chunks[0]!.nodeId).toBe('chunk-0')
    expect(chunks[1]!.nodeId).toBe('chunk-1')
    expect(chunks[2]!.nodeId).toBe('chunk-2')
  })
})

describe('utility functions', () => {
  it('formatHasColor returns correct values', () => {
    expect(formatHasColor(0)).toBe(false)
    expect(formatHasColor(1)).toBe(false)
    expect(formatHasColor(2)).toBe(true)
    expect(formatHasColor(3)).toBe(true)
    expect(formatHasColor(6)).toBe(false)
    expect(formatHasColor(7)).toBe(true)
  })

  it('getFormatAttributes returns known attributes', () => {
    expect(getFormatAttributes(0)).toContain('x')
    expect(getFormatAttributes(0)).not.toContain('gps_time')
    expect(getFormatAttributes(1)).toContain('gps_time')
    expect(getFormatAttributes(2)).toContain('red')
    expect(getFormatAttributes(3)).toContain('gps_time')
    expect(getFormatAttributes(3)).toContain('red')
    expect(getFormatAttributes(7)).toContain('red')
    expect(getFormatAttributes(7)).toContain('gps_time')
  })

  it('dEFAULT_CHUNK_SIZE is 100K', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(100_000)
  })

  it('pOINT_RECORD_BASE_SIZES has entries for supported formats', () => {
    expect(POINT_RECORD_BASE_SIZES[0]).toBe(20)
    expect(POINT_RECORD_BASE_SIZES[1]).toBe(28)
    expect(POINT_RECORD_BASE_SIZES[2]).toBe(26)
    expect(POINT_RECORD_BASE_SIZES[3]).toBe(34)
    expect(POINT_RECORD_BASE_SIZES[6]).toBe(30)
    expect(POINT_RECORD_BASE_SIZES[7]).toBe(36)
  })
})
