/* eslint-disable style/max-statements-per-line */
/**
 * LAS 1.0–1.4 streaming parser + 2D screen-space edit operations.
 *
 * Design goals:
 * - Never load full file into memory (File.slice streaming)
 * - No per-point object allocation (typed arrays only)
 * - Edit operations stored as descriptors, replayed on save
 * - Undo via operation stack, not PointData snapshots
 */

export interface PointData {
  positions: Float32Array // xyz centered, length = count*3
  colors: Uint8Array // rgb 0-255, length = count*3
  intensity: Uint8Array // 0-255, length = count
  count: number
  isGrayscale: boolean
  avgSpacing: number // estimated average point spacing in world units (meters)
  bounds: { xn: number, xx: number, yn: number, yx: number, zn: number, zx: number }
}

export interface EditOp {
  matrix: number[] // 4x4 column-major viewProjectionMatrix
  rect: [number, number, number, number] // L, T, R, B (CSS px)
  vpWidth: number
  vpHeight: number
  keepInside: boolean
}

// ── Fast byte reads ──
function rI32(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) }
function rU32(b: Uint8Array, o: number) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 }
function rU16(b: Uint8Array, o: number) { return b[o] | (b[o + 1] << 8) }
function rF64(b: Uint8Array, o: number) {
  return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true)
}

const RGB_OFF: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }

// ── Load (streaming) ──

export async function loadLAS(
  file: File,
  maxPoints: number,
  onProgress?: (pct: number) => void,
): Promise<PointData> {
  const h = new Uint8Array(await file.slice(0, 400).arrayBuffer())
  if (String.fromCharCode(h[0], h[1], h[2], h[3]) !== 'LASF')
    throw new Error('Not a valid LAS file')

  const vMaj = h[24]; const vMin = h[25]; const offPts = rU32(h, 96); const fmt = h[104]; const recLen = rU16(h, 105)
  let numPts: number
  if (vMaj === 1 && vMin >= 4) { const lo = rU32(h, 247); const hi = rU32(h, 251); numPts = hi > 0 ? lo + hi * 4294967296 : (rU32(h, 107) || lo) }
  else {
    numPts = rU32(h, 107)
  }

  const xs = rF64(h, 131); const ys = rF64(h, 139); const zs = rF64(h, 147)
  const xo = rF64(h, 155); const yo = rF64(h, 163); const zo = rF64(h, 171)
  const xMin = rF64(h, 187); const yMin = rF64(h, 203); const zMin = rF64(h, 219)
  const xMax = rF64(h, 179); const yMax = rF64(h, 195); const zMax = rF64(h, 211)
  const rgbOff = RGB_OFF[fmt]; const hasRGB = rgbOff !== undefined

  // Color scale from small sample
  let cScale = 1
  if (hasRGB) {
    const sb = new Uint8Array(await file.slice(offPts, Math.min(offPts + 5000 * recLen, file.size)).arrayBuffer())
    let mx = 1
    for (let i = 0; i < Math.min(2000, sb.length / recLen); i++) {
      const o = i * recLen + rgbOff; if (o + 6 > sb.length)
        break; const r = rU16(sb, o); const g = rU16(sb, o + 2); const b = rU16(sb, o + 4); if (r > mx)
        mx = r; if (g > mx)
        mx = g; if (b > mx)
        mx = b
    }
    cScale = 255 / mx
  }

  const cx = (xMin + xMax) / 2; const cy = (yMin + yMax) / 2; const cz = (zMin + zMax) / 2
  const cap = maxPoints > 0 ? maxPoints : 10_000_000
  const step = numPts > cap ? Math.ceil(numPts / cap) : 1
  const targetN = Math.ceil(numPts / step)

  const positions = new Float32Array(targetN * 3)
  const colors = new Uint8Array(targetN * 3)
  const intensity = new Uint8Array(targetN)
  let total = 0; let grayDiff = 0

  const BLOCK = 32 * 1024 * 1024; const bPts = Math.floor(BLOCK / recLen); const bBytes = bPts * recLen
  const dataSize = numPts * recLen
  let nextIdx = 0

  for (let bStart = 0; bStart < dataSize; bStart += bBytes) {
    const bEnd = Math.min(bStart + bBytes, dataSize); const iStart = bStart / recLen; const iEnd = bEnd / recLen
    if (nextIdx >= iEnd)
      continue
    const buf = new Uint8Array(await file.slice(offPts + bStart, offPts + bEnd).arrayBuffer())
    while (nextIdx < iEnd && nextIdx < numPts) {
      const lo = (nextIdx - iStart) * recLen
      if (lo < 0 || lo + recLen > buf.length)
        break
      const j = total
      positions[j * 3] = rI32(buf, lo) * xs + xo - cx; positions[j * 3 + 1] = rI32(buf, lo + 4) * ys + yo - cy; positions[j * 3 + 2] = rI32(buf, lo + 8) * zs + zo - cz
      // Intensity: uint16 LE at offset 12, normalize to 0-255
      const rawInt = rU16(buf, lo + 12)
      intensity[j] = rawInt > 255 ? (rawInt >> 8) : rawInt
      if (hasRGB) {
        const ro = lo + rgbOff; const r = (rU16(buf, ro) * cScale + 0.5) | 0; const g = (rU16(buf, ro + 2) * cScale + 0.5) | 0; const b = (rU16(buf, ro + 4) * cScale + 0.5) | 0; colors[j * 3] = r; colors[j * 3 + 1] = g; colors[j * 3 + 2] = b; if (total < 500)
          grayDiff += Math.abs(r - g) + Math.abs(g - b)
      }
      total++; nextIdx += step
    }
    onProgress?.(bEnd / dataSize)
    await new Promise(r => setTimeout(r, 0))
  }

  // Compute bounds and average spacing
  const pos = positions
  let bxn = 1e30; let bxx = -1e30; let byn = 1e30; let byx = -1e30; let bzn = 1e30; let bzx = -1e30
  const bStep = Math.max(1, (total / 50000) | 0)
  for (let i = 0; i < total; i += bStep) {
    const x = pos[i * 3]; const y = pos[i * 3 + 1]; const z = pos[i * 3 + 2]; if (x < bxn)
      bxn = x; if (x > bxx)
      bxx = x; if (y < byn)
      byn = y; if (y > byx)
      byx = y; if (z < bzn)
      bzn = z; if (z > bzx)
      bzx = z
  }
  const bounds = { xn: bxn, xx: bxx, yn: byn, yx: byx, zn: bzn, zx: bzx }
  // Estimate surface area (project to 2D bounding rect × 2 for two sides)
  const surfaceEst = Math.max((bxx - bxn) * (byx - byn), (bxx - bxn) * (bzx - bzn), (byx - byn) * (bzx - bzn)) * 2
  const avgSpacing = surfaceEst > 0 ? Math.sqrt(surfaceEst / total) : 0.01

  const sc = Math.min(total, 500)
  return {
    positions: positions.subarray(0, total * 3),
    colors: colors.subarray(0, total * 3),
    intensity: intensity.subarray(0, total),
    count: total,
    isGrayscale: !hasRGB || (sc > 0 && grayDiff / sc < 3),
    avgSpacing,
    bounds,
  }
}

// ── Edit projection ──

function isDeletedByOp(px: number, py: number, pz: number, m: number[], L: number, T: number, R: number, B: number, vpW: number, vpH: number, keep: boolean): boolean {
  const cw = m[3] * px + m[7] * py + m[11] * pz + m[15]
  if (cw <= 0)
    return keep
  const sx = (m[0] * px + m[4] * py + m[8] * pz + m[12]) / (cw * 2) + 0.5
  const sy = 0.5 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / (cw * 2)
  const inside = sx * vpW >= L && sx * vpW <= R && sy * vpH >= T && sy * vpH <= B
  return keep ? !inside : inside
}

/**
 * Apply one edit op to display data — uses bitmap instead of index array.
 * No per-point object allocation.
 */
export function applyOp(data: PointData, op: EditOp): { result: PointData, removedCount: number } {
  const { positions: p, colors: c, intensity: it, count } = data
  const { matrix: m, rect: [L, T, R, B], vpWidth: w, vpHeight: h, keepInside: keep } = op

  // Bitmap: 0=keep, 1=delete — no JS array of numbers
  let removed = 0
  const bitmap = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    if (isDeletedByOp(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], m, L, T, R, B, w, h, keep)) { bitmap[i] = 1; removed++ }
  }
  if (removed === 0)
    return { result: data, removedCount: 0 }

  const n = count - removed
  const np = new Float32Array(n * 3); const nc = new Uint8Array(n * 3); const ni = new Uint8Array(n)
  let j = 0
  for (let i = 0; i < count; i++) {
    if (bitmap[i])
      continue
    np[j * 3] = p[i * 3]; np[j * 3 + 1] = p[i * 3 + 1]; np[j * 3 + 2] = p[i * 3 + 2]
    nc[j * 3] = c[i * 3]; nc[j * 3 + 1] = c[i * 3 + 1]; nc[j * 3 + 2] = c[i * 3 + 2]
    ni[j] = it[i]; j++
  }
  return { result: { positions: np, colors: nc, intensity: ni, count: n, isGrayscale: data.isGrayscale, avgSpacing: data.avgSpacing, bounds: data.bounds }, removedCount: removed }
}

// ── Save (streaming, no per-point slice) ──

export async function saveLAS(file: File, ops: EditOp[], onProgress: (pct: number) => void): Promise<Blob> {
  if (!ops.length)
    return file

  const h = new Uint8Array(await file.slice(0, 400).arrayBuffer())
  const vMaj = h[24]; const vMin = h[25]; const offPts = rU32(h, 96); const recLen = rU16(h, 105)
  let numPts: number
  if (vMaj === 1 && vMin >= 4) { const lo = rU32(h, 247); const hi = rU32(h, 251); numPts = hi > 0 ? lo + hi * 4294967296 : (rU32(h, 107) || lo) }
  else {
    numPts = rU32(h, 107)
  }
  const xs = rF64(h, 131); const ys = rF64(h, 139); const zs = rF64(h, 147); const xo = rF64(h, 155); const yo = rF64(h, 163); const zo = rF64(h, 171)
  const xMin = rF64(h, 187); const yMin = rF64(h, 203); const zMin = rF64(h, 219); const xMax = rF64(h, 179); const yMax = rF64(h, 195); const zMax = rF64(h, 211)
  const cx = (xMin + xMax) / 2; const cy = (yMin + yMax) / 2; const cz = (zMin + zMax) / 2

  // Pass 1: mark deleted
  const deleted = new Uint8Array(numPts)
  const BLOCK = 32 * 1024 * 1024; const bPts = Math.floor(BLOCK / recLen); const bBytes = bPts * recLen; const dataSize = numPts * recLen
  for (let bStart = 0; bStart < dataSize; bStart += bBytes) {
    const bEnd = Math.min(bStart + bBytes, dataSize); const iStart = bStart / recLen; const iEnd = Math.min(bEnd / recLen, numPts)
    const buf = new Uint8Array(await file.slice(offPts + bStart, offPts + bEnd).arrayBuffer())
    for (let i = iStart; i < iEnd; i++) {
      const lo = (i - iStart) * recLen
      const px = rI32(buf, lo) * xs + xo - cx; const py = rI32(buf, lo + 4) * ys + yo - cy; const pz = rI32(buf, lo + 8) * zs + zo - cz
      for (const op of ops) {
        if (isDeletedByOp(px, py, pz, op.matrix, op.rect[0], op.rect[1], op.rect[2], op.rect[3], op.vpWidth, op.vpHeight, op.keepInside)) { deleted[i] = 1; break }
      }
    }
    onProgress(0.4 * bEnd / dataSize); await new Promise(r => setTimeout(r, 0))
  }

  let keepCount = 0; for (let i = 0; i < numPts; i++) {
    if (!deleted[i])
      keepCount++
  }

  // Write header
  const headerBuf = new Uint8Array(await file.slice(0, offPts).arrayBuffer())
  const outH = new Uint8Array(headerBuf); const hDv = new DataView(outH.buffer)
  if (vMaj === 1 && vMin >= 4) { hDv.setUint32(107, Math.min(keepCount, 0xFFFFFFFF), true); hDv.setUint32(247, keepCount >>> 0, true); hDv.setUint32(251, 0, true) }
  else {
    hDv.setUint32(107, keepCount, true)
  }

  // Pass 2: batch-copy surviving records into pre-allocated block buffers
  const parts: Uint8Array[] = [outH]
  for (let bStart = 0; bStart < dataSize; bStart += bBytes) {
    const bEnd = Math.min(bStart + bBytes, dataSize); const iStart = bStart / recLen; const iEnd = Math.min(bEnd / recLen, numPts)
    const buf = new Uint8Array(await file.slice(offPts + bStart, offPts + bEnd).arrayBuffer())

    // Count survivors in this block
    let blockKeep = 0
    for (let i = iStart; i < iEnd; i++) {
      if (!deleted[i])
        blockKeep++
    }
    if (blockKeep === 0) { onProgress(0.4 + 0.6 * bEnd / dataSize); await new Promise(r => setTimeout(r, 0)); continue }

    // Pre-allocate output for this block, batch copy
    const out = new Uint8Array(blockKeep * recLen)
    let wOff = 0
    for (let i = iStart; i < iEnd; i++) {
      if (deleted[i])
        continue
      const srcOff = (i - iStart) * recLen
      out.set(buf.subarray(srcOff, srcOff + recLen), wOff)
      wOff += recLen
    }
    parts.push(out)
    onProgress(0.4 + 0.6 * bEnd / dataSize); await new Promise(r => setTimeout(r, 0))
  }

  return new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
}
