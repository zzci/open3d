/**
 * Save a filtered LAS file by reading the original and keeping only points
 * whose centered positions match a "kept" set.
 *
 * This avoids matrix projection replay issues with deck.gl coordinates.
 */

function rU32(b: Uint8Array, o: number) { return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 }
function rU16(b: Uint8Array, o: number) { return b[o]! | (b[o + 1]! << 8) }
function rI32(b: Uint8Array, o: number) { return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24) }
function rF64(b: Uint8Array, o: number) {
  return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true)
}

export async function saveFilteredLAS(
  file: File,
  kept: Set<string>,
  onProgress: (pct: number) => void,
): Promise<Blob> {
  const h = new Uint8Array(await file.slice(0, 400).arrayBuffer())
  const vMaj = h[24]!
  const vMin = h[25]!
  const offPts = rU32(h, 96)
  const recLen = rU16(h, 105)

  let numPts: number
  if (vMaj === 1 && vMin >= 4) {
    const lo = rU32(h, 247)
    const hi = rU32(h, 251)
    numPts = hi > 0 ? lo + hi * 4294967296 : (rU32(h, 107) || lo)
  }
  else {
    numPts = rU32(h, 107)
  }

  const xs = rF64(h, 131)
  const ys = rF64(h, 139)
  const zs = rF64(h, 147)
  const xo = rF64(h, 155)
  const yo = rF64(h, 163)
  const zo = rF64(h, 171)
  const xMin = rF64(h, 187)
  const xMax = rF64(h, 179)
  const yMin = rF64(h, 203)
  const yMax = rF64(h, 195)
  const zMin = rF64(h, 219)
  const zMax = rF64(h, 211)

  const cx = (xMin + xMax) / 2
  const cy = (yMin + yMax) / 2
  const cz = (zMin + zMax) / 2

  // Pass 1: mark which points to keep
  const BLOCK = 32 * 1024 * 1024
  const bPts = Math.floor(BLOCK / recLen)
  const bBytes = bPts * recLen
  const dataSize = numPts * recLen

  const deleted = new Uint8Array(numPts)
  for (let bStart = 0; bStart < dataSize; bStart += bBytes) {
    const bEnd = Math.min(bStart + bBytes, dataSize)
    const iStart = bStart / recLen
    const iEnd = Math.min(bEnd / recLen, numPts)
    const buf = new Uint8Array(await file.slice(offPts + bStart, offPts + bEnd).arrayBuffer())

    for (let i = iStart; i < iEnd; i++) {
      const lo = (i - iStart) * recLen
      const px = rI32(buf, lo) * xs + xo - cx
      const py = rI32(buf, lo + 4) * ys + yo - cy
      const pz = rI32(buf, lo + 8) * zs + zo - cz
      const key = `${(px * 1000) | 0},${(py * 1000) | 0},${(pz * 1000) | 0}`
      if (!kept.has(key)) {
        deleted[i] = 1
      }
    }

    onProgress(0.4 * bEnd / dataSize)
    await new Promise(r => setTimeout(r, 0))
  }

  let keepCount = 0
  for (let i = 0; i < numPts; i++) {
    if (!deleted[i]) keepCount++
  }

  // Write header
  const headerBuf = new Uint8Array(await file.slice(0, offPts).arrayBuffer())
  const outH = new Uint8Array(headerBuf)
  const hDv = new DataView(outH.buffer)
  if (vMaj === 1 && vMin >= 4) {
    hDv.setUint32(107, Math.min(keepCount, 0xFFFFFFFF), true)
    hDv.setUint32(247, keepCount >>> 0, true)
    hDv.setUint32(251, 0, true)
  }
  else {
    hDv.setUint32(107, keepCount, true)
  }

  // Pass 2: copy surviving records
  const parts: Uint8Array[] = [outH]
  for (let bStart = 0; bStart < dataSize; bStart += bBytes) {
    const bEnd = Math.min(bStart + bBytes, dataSize)
    const iStart = bStart / recLen
    const iEnd = Math.min(bEnd / recLen, numPts)
    const buf = new Uint8Array(await file.slice(offPts + bStart, offPts + bEnd).arrayBuffer())

    let blockKeep = 0
    for (let i = iStart; i < iEnd; i++) {
      if (!deleted[i]) blockKeep++
    }
    if (blockKeep === 0) {
      onProgress(0.4 + 0.6 * bEnd / dataSize)
      await new Promise(r => setTimeout(r, 0))
      continue
    }

    const out = new Uint8Array(blockKeep * recLen)
    let wOff = 0
    for (let i = iStart; i < iEnd; i++) {
      if (deleted[i]) continue
      const srcOff = (i - iStart) * recLen
      out.set(buf.subarray(srcOff, srcOff + recLen), wOff)
      wOff += recLen
    }
    parts.push(out)
    onProgress(0.4 + 0.6 * bEnd / dataSize)
    await new Promise(r => setTimeout(r, 0))
  }

  return new Blob(parts as BlobPart[], { type: 'application/octet-stream' })
}
