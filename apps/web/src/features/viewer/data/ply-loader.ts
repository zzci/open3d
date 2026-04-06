/**
 * PLY point cloud loader — supports ASCII and binary_little_endian formats.
 * Returns the same PointCloudData interface as LAS loader.
 */

import type { PointCloudData } from '../renderer/deck-viewer'

interface PlyProperty {
  name: string
  type: string // float, double, uchar, int, short, etc.
  byteSize: number
}

const TYPE_SIZES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4,
  double: 8, float64: 8,
}

function parseHeader(text: string): { format: string, vertexCount: number, properties: PlyProperty[], headerBytes: number } {
  const lines = text.split('\n')
  let format = 'ascii'
  let vertexCount = 0
  const properties: PlyProperty[] = []
  let inVertex = false
  let headerEnd = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    headerEnd += lines[i]!.length + 1 // +1 for \n

    if (line.startsWith('format ')) {
      format = line.split(/\s+/)[1]!
    }
    else if (line.startsWith('element vertex ')) {
      vertexCount = Number.parseInt(line.split(/\s+/)[2]!, 10)
      inVertex = true
    }
    else if (line.startsWith('element ') && inVertex) {
      inVertex = false // another element started
    }
    else if (line.startsWith('property ') && inVertex) {
      const parts = line.split(/\s+/)
      if (parts[1] === 'list') continue // skip list properties (face data)
      const type = parts[1]!
      const name = parts[2]!
      properties.push({ name, type, byteSize: TYPE_SIZES[type] ?? 4 })
    }
    else if (line === 'end_header') {
      break
    }
  }

  return { format, vertexCount, properties, headerBytes: headerEnd }
}

function readValue(view: DataView, offset: number, type: string): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset)
    case 'uchar': case 'uint8': return view.getUint8(offset)
    case 'short': case 'int16': return view.getInt16(offset, true)
    case 'ushort': case 'uint16': return view.getUint16(offset, true)
    case 'int': case 'int32': return view.getInt32(offset, true)
    case 'uint': case 'uint32': return view.getUint32(offset, true)
    case 'float': case 'float32': return view.getFloat32(offset, true)
    case 'double': case 'float64': return view.getFloat64(offset, true)
    default: return view.getFloat32(offset, true)
  }
}

export async function loadPLY(
  file: File,
  maxPoints: number,
  onProgress?: (pct: number) => void,
): Promise<PointCloudData> {
  // Read enough for header (usually < 1KB)
  const headerChunk = await file.slice(0, Math.min(file.size, 8192)).arrayBuffer()
  const headerText = new TextDecoder().decode(headerChunk)

  if (!headerText.startsWith('ply')) {
    throw new Error('Not a PLY file')
  }

  const { format, vertexCount, properties, headerBytes } = parseHeader(headerText)
  const numPts = vertexCount

  // Find property indices
  const xIdx = properties.findIndex(p => p.name === 'x')
  const yIdx = properties.findIndex(p => p.name === 'y')
  const zIdx = properties.findIndex(p => p.name === 'z')
  const rIdx = properties.findIndex(p => p.name === 'red')
  const gIdx = properties.findIndex(p => p.name === 'green')
  const bIdx = properties.findIndex(p => p.name === 'blue')
  const intIdx = properties.findIndex(p => p.name === 'intensity' || p.name === 'scalar_intensity')
  const nxIdx = properties.findIndex(p => p.name === 'nx')

  if (xIdx < 0 || yIdx < 0 || zIdx < 0) {
    throw new Error('PLY file missing x/y/z properties')
  }

  const hasRGB = rIdx >= 0 && gIdx >= 0 && bIdx >= 0
  const hasIntensity = intIdx >= 0
  const vertexByteSize = properties.reduce((sum, p) => sum + p.byteSize, 0)

  // Downsampling
  const cap = maxPoints > 0 ? maxPoints : numPts
  const step = numPts > cap ? Math.ceil(numPts / cap) : 1
  const targetN = Math.ceil(numPts / step)

  // Center calculation — read bounds from a quick scan
  const fullBuf = await file.arrayBuffer()

  // Compute centroid from all points
  let cxSum = 0, cySum = 0, czSum = 0

  if (format === 'ascii') {
    const text = new TextDecoder().decode(fullBuf)
    const dataStart = text.indexOf('end_header\n') + 'end_header\n'.length
    const dataLines = text.slice(dataStart).split('\n')

    // Quick centroid from first 10K points
    const sampleN = Math.min(numPts, 10000)
    for (let i = 0; i < sampleN; i++) {
      const vals = dataLines[i]!.trim().split(/\s+/)
      cxSum += Number(vals[xIdx])
      cySum += Number(vals[yIdx])
      czSum += Number(vals[zIdx])
    }
    const cx = cxSum / sampleN, cy = cySum / sampleN, cz = czSum / sampleN

    // Read all points
    const positions = new Float32Array(targetN * 3)
    const colors = new Uint8Array(targetN * 3)
    const intensity = new Uint8Array(targetN)
    let total = 0, grayDiff = 0

    for (let idx = 0, nextIdx = 0; nextIdx < numPts && total < targetN; nextIdx += step, idx++) {
      const line = dataLines[nextIdx]
      if (!line) break
      const vals = line.trim().split(/\s+/)
      if (vals.length < properties.length) continue

      positions[total * 3] = Number(vals[xIdx]) - cx
      positions[total * 3 + 1] = Number(vals[zIdx]) - cz  // Z→Y (Three.js Y-up)
      positions[total * 3 + 2] = -(Number(vals[yIdx]) - cy) // -Y→Z

      if (hasRGB) {
        const r = Number(vals[rIdx]), g = Number(vals[gIdx]), b = Number(vals[bIdx])
        colors[total * 3] = r > 1 ? r : (r * 255) | 0
        colors[total * 3 + 1] = g > 1 ? g : (g * 255) | 0
        colors[total * 3 + 2] = b > 1 ? b : (b * 255) | 0
        if (total < 500) grayDiff += Math.abs(r - g) + Math.abs(g - b)
      }

      if (hasIntensity) {
        const v = Number(vals[intIdx])
        intensity[total] = v > 1 ? (v > 255 ? (v >> 8) : v) : (v * 255) | 0
      }
      else if (hasRGB) {
        intensity[total] = ((colors[total * 3]! + colors[total * 3 + 1]! + colors[total * 3 + 2]!) / 3) | 0
      }

      total++
      if (total % 100000 === 0) {
        onProgress?.(total / targetN)
        await new Promise(r => setTimeout(r, 0))
      }
    }

    return buildResult(positions, colors, intensity, total, hasRGB, grayDiff)
  }
  else {
    // Binary little endian
    const view = new DataView(fullBuf)
    const dataStart = headerBytes

    // Quick centroid
    const sampleN = Math.min(numPts, 10000)
    const propOffsets = computeOffsets(properties)
    for (let i = 0; i < sampleN; i++) {
      const base = dataStart + i * vertexByteSize
      cxSum += readValue(view, base + propOffsets[xIdx]!, properties[xIdx]!.type)
      cySum += readValue(view, base + propOffsets[yIdx]!, properties[yIdx]!.type)
      czSum += readValue(view, base + propOffsets[zIdx]!, properties[zIdx]!.type)
    }
    const cx = cxSum / sampleN, cy = cySum / sampleN, cz = czSum / sampleN

    const positions = new Float32Array(targetN * 3)
    const colors = new Uint8Array(targetN * 3)
    const intensity = new Uint8Array(targetN)
    let total = 0, grayDiff = 0

    for (let nextIdx = 0; nextIdx < numPts && total < targetN; nextIdx += step) {
      const base = dataStart + nextIdx * vertexByteSize

      positions[total * 3] = readValue(view, base + propOffsets[xIdx]!, properties[xIdx]!.type) - cx
      positions[total * 3 + 1] = readValue(view, base + propOffsets[zIdx]!, properties[zIdx]!.type) - cz  // Z→Y
      positions[total * 3 + 2] = -(readValue(view, base + propOffsets[yIdx]!, properties[yIdx]!.type) - cy) // -Y→Z

      if (hasRGB) {
        let r = readValue(view, base + propOffsets[rIdx]!, properties[rIdx]!.type)
        let g = readValue(view, base + propOffsets[gIdx]!, properties[gIdx]!.type)
        let b = readValue(view, base + propOffsets[bIdx]!, properties[bIdx]!.type)
        // Normalize float colors (0-1) to 0-255
        if (properties[rIdx]!.type === 'float' || properties[rIdx]!.type === 'float32' || properties[rIdx]!.type === 'double') {
          r = (r * 255) | 0; g = (g * 255) | 0; b = (b * 255) | 0
        }
        colors[total * 3] = r
        colors[total * 3 + 1] = g
        colors[total * 3 + 2] = b
        if (total < 500) grayDiff += Math.abs(r - g) + Math.abs(g - b)
      }

      if (hasIntensity) {
        const v = readValue(view, base + propOffsets[intIdx]!, properties[intIdx]!.type)
        intensity[total] = v > 1 ? (v > 255 ? (v >> 8) : v) : (v * 255) | 0
      }
      else if (hasRGB) {
        intensity[total] = ((colors[total * 3]! + colors[total * 3 + 1]! + colors[total * 3 + 2]!) / 3) | 0
      }

      total++
      if (total % 200000 === 0) {
        onProgress?.(total / targetN)
        await new Promise(r => setTimeout(r, 0))
      }
    }

    onProgress?.(1)
    return buildResult(positions, colors, intensity, total, hasRGB, grayDiff)
  }
}

function computeOffsets(properties: PlyProperty[]): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const p of properties) {
    offsets.push(offset)
    offset += p.byteSize
  }
  return offsets
}

function buildResult(
  positions: Float32Array,
  colors: Uint8Array,
  intensity: Uint8Array,
  total: number,
  hasRGB: boolean,
  grayDiff: number,
): PointCloudData {
  const pos = positions.subarray(0, total * 3)
  let bxn = 1e30, bxx = -1e30, byn = 1e30, byx = -1e30, bzn = 1e30, bzx = -1e30
  const bStep = Math.max(1, (total / 50000) | 0)
  for (let i = 0; i < total; i += bStep) {
    const x = pos[i * 3]!, y = pos[i * 3 + 1]!, z = pos[i * 3 + 2]!
    if (x < bxn) bxn = x; if (x > bxx) bxx = x
    if (y < byn) byn = y; if (y > byx) byx = y
    if (z < bzn) bzn = z; if (z > bzx) bzx = z
  }
  const bounds = { xn: bxn, xx: bxx, yn: byn, yx: byx, zn: bzn, zx: bzx }
  const surfaceEst = Math.max((bxx - bxn) * (byx - byn), (bxx - bxn) * (bzx - bzn), (byx - byn) * (bzx - bzn)) * 2
  const avgSpacing = surfaceEst > 0 ? Math.sqrt(surfaceEst / total) : 0.01
  const sc = Math.min(total, 500)

  return {
    positions: pos,
    colors: colors.subarray(0, total * 3),
    intensity: intensity.subarray(0, total),
    count: total,
    isGrayscale: !hasRGB || (sc > 0 && grayDiff / sc < 3),
    avgSpacing,
    bounds,
  }
}
