import type { DecodeTilePayload, TileData, WorkerRequest, WorkerResponse } from '../data/types'

// ---------------------------------------------------------------------------
// laz-perf WASM types (Emscripten module)
// ---------------------------------------------------------------------------

interface LazPerfModule {
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  HEAPU8: Uint8Array
  ChunkDecoder: new () => {
    delete: () => void
    open: (
      pointDataRecordFormat: number,
      pointDataRecordLength: number,
      pointer: number,
    ) => void
    getPoint: (dest: number) => void
  }
}

// ---------------------------------------------------------------------------
// Module-level state — pre-init WASM on worker startup
// ---------------------------------------------------------------------------

let lazPerf: LazPerfModule | null = null
const initPromise = initLazPerf()

async function initLazPerf(): Promise<void> {
  const { create } = await import('laz-perf')
  lazPerf = (await create({
    locateFile: (file: string) => {
      if (file.endsWith('.wasm'))
        return '/laz-perf.wasm'
      return file
    },
  })) as unknown as LazPerfModule
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respond(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    globalThis.postMessage(msg, { transfer })
  }
  else {
    globalThis.postMessage(msg)
  }
}

function sliceFile(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer()
}

/**
 * Check if the point format has RGB color fields.
 */
function formatHasColor(format: number): boolean {
  return format === 2 || format === 3 || format === 7 || format === 8
}

// ---------------------------------------------------------------------------
// Point extraction — decode raw (decompressed) point records into typed arrays
// ---------------------------------------------------------------------------

function extractPoints(
  buffer: ArrayBuffer,
  pointCount: number,
  pointRecordLength: number,
  pointFormat: number,
  scale: [number, number, number],
  offset: [number, number, number],
): { positions: Float32Array, colors: Uint8Array | undefined, intensity: Float32Array, intensityEqualized: Float32Array, classification: Uint8Array } {
  const view = new DataView(buffer)
  const hasColor = formatHasColor(pointFormat)

  const positions = new Float32Array(pointCount * 3)
  const colors = hasColor ? new Uint8Array(pointCount * 3) : undefined
  const intensity = new Float32Array(pointCount)
  const classification = new Uint8Array(pointCount)

  for (let i = 0; i < pointCount; i++) {
    const off = i * pointRecordLength

    // XYZ — stored as int32, scaled
    const x = view.getInt32(off, true) * scale[0] + offset[0]
    const y = view.getInt32(off + 4, true) * scale[1] + offset[1]
    const z = view.getInt32(off + 8, true) * scale[2] + offset[2]

    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z

    // Intensity — 16-bit, normalize to 0-1
    intensity[i] = view.getUint16(off + 12, true) / 65535

    // Classification + color depend on format
    if (pointFormat <= 5) {
      classification[i] = view.getUint8(off + 15)

      if (colors) {
        let colorOff: number
        if (pointFormat === 2) {
          colorOff = off + 20
        }
        else {
          // format 3: GPS time at +20 (8 bytes), then RGB at +28
          colorOff = off + 28
        }
        colors[i * 3] = view.getUint16(colorOff, true) >> 8
        colors[i * 3 + 1] = view.getUint16(colorOff + 2, true) >> 8
        colors[i * 3 + 2] = view.getUint16(colorOff + 4, true) >> 8
      }
    }
    else {
      // LAS 1.4 formats 6-8
      classification[i] = view.getUint8(off + 16)

      if (colors && (pointFormat === 7 || pointFormat === 8)) {
        const colorOff = off + 30
        colors[i * 3] = view.getUint16(colorOff, true) >> 8
        colors[i * 3 + 1] = view.getUint16(colorOff + 2, true) >> 8
        colors[i * 3 + 2] = view.getUint16(colorOff + 4, true) >> 8
      }
    }
  }

  // Histogram equalization: build CDF from 256-bucket histogram, remap intensity
  const buckets = 256
  const histogram = new Uint32Array(buckets)
  for (let i = 0; i < pointCount; i++) {
    const bin = Math.min(Math.floor(intensity[i]! * buckets), buckets - 1)
    histogram[bin]!++
  }

  // Build CDF lookup table
  const cdf = new Float32Array(buckets)
  cdf[0] = histogram[0]!
  for (let i = 1; i < buckets; i++) {
    cdf[i] = cdf[i - 1]! + histogram[i]!
  }

  // Find first non-zero CDF entry
  let cdfMin = 0
  for (let i = 0; i < buckets; i++) {
    if (cdf[i]! > 0) {
      cdfMin = cdf[i]!
      break
    }
  }

  const intensityEqualized = new Float32Array(pointCount)
  const denominator = pointCount - cdfMin
  if (denominator > 0) {
    for (let i = 0; i < pointCount; i++) {
      const bin = Math.min(Math.floor(intensity[i]! * buckets), buckets - 1)
      intensityEqualized[i] = (cdf[bin]! - cdfMin) / denominator
    }
  }

  return { positions, colors, intensity, intensityEqualized, classification }
}

// ---------------------------------------------------------------------------
// LAZ decompression via laz-perf ChunkDecoder
// ---------------------------------------------------------------------------

function decompressLaz(
  compressed: Uint8Array,
  pointCount: number,
  pointFormat: number,
  pointRecordLength: number,
): ArrayBuffer {
  const lp = lazPerf!
  const outputSize = pointCount * pointRecordLength
  const output = new ArrayBuffer(outputSize)
  const outputView = new Uint8Array(output)

  // Allocate WASM memory for compressed input
  const srcPtr = lp._malloc(compressed.length)
  lp.HEAPU8.set(compressed, srcPtr)

  // Allocate buffer for one decompressed point
  const pointPtr = lp._malloc(pointRecordLength)

  const decoder = new lp.ChunkDecoder()
  try {
    decoder.open(pointFormat, pointRecordLength, srcPtr)

    for (let i = 0; i < pointCount; i++) {
      decoder.getPoint(pointPtr)
      outputView.set(
        lp.HEAPU8.subarray(pointPtr, pointPtr + pointRecordLength),
        i * pointRecordLength,
      )
    }
  }
  finally {
    decoder.delete()
    lp._free(pointPtr)
    lp._free(srcPtr)
  }

  return output
}

// ---------------------------------------------------------------------------
// Tile decode handler
// ---------------------------------------------------------------------------

async function decodeTile(payload: DecodeTilePayload): Promise<{
  tileData: TileData
  transfer: Transferable[]
}> {
  await initPromise

  const {
    file,
    nodeId,
    level,
    byteOffset,
    byteSize,
    pointCount,
    bounds,
    pointFormat,
    pointRecordLength,
    scale,
    offset,
  } = payload

  // Read compressed bytes from file
  const compressed = await sliceFile(file, byteOffset, byteSize)
  const compressedBytes = new Uint8Array(compressed)

  // Decompress LAZ → raw point records
  const rawBuffer = decompressLaz(compressedBytes, pointCount, pointFormat, pointRecordLength)

  // Extract typed arrays from raw point records
  const { positions, colors, intensity, intensityEqualized, classification } = extractPoints(
    rawBuffer,
    pointCount,
    pointRecordLength,
    pointFormat,
    scale,
    offset,
  )

  const tileData: TileData = {
    nodeId,
    level,
    pointCount,
    bounds,
    positions,
    colors,
    intensity,
    intensityEqualized,
    classification,
  }

  // Collect ArrayBuffers for Transferable transport (zero-copy)
  const transfer: Transferable[] = [
    positions.buffer,
    intensity.buffer,
    intensityEqualized.buffer,
    classification.buffer,
  ]
  if (colors) {
    transfer.push(colors.buffer)
  }

  return { tileData, transfer }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload } = event.data

  if (type === 'init') {
    // Ensure WASM is ready (pre-init already started, just await)
    try {
      await initPromise
      respond({ requestId, type: 'result', payload: { ready: true } })
    }
    catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to init laz-perf'
      respond({ requestId, type: 'error', payload: { message } })
    }
    return
  }

  if (type !== 'decode-tile') {
    respond({
      requestId,
      type: 'error',
      payload: { message: `Unknown request type: ${type}` },
    })
    return
  }

  try {
    const { tileData, transfer } = await decodeTile(payload as DecodeTilePayload)
    respond({ requestId, type: 'result', payload: tileData }, transfer)
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Decode failed'
    respond({ requestId, type: 'error', payload: { message } })
  }
}
