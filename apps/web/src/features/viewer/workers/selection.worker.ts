// ---------------------------------------------------------------------------
// Selection Worker
//
// Input:  MVP matrix (Float64Array 16), screen rect (x0,y0,x1,y1 in NDC),
//         viewport width/height, and per-tile positions (Float32Array).
// Output: per-tile Uint8Array bitmask (1 = selected, 0 = not).
//
// Runs in a dedicated Worker to keep the main thread responsive.
// ---------------------------------------------------------------------------

export interface SelectionRequest {
  requestId: string
  type: 'select'
  payload: SelectionPayload
}

export interface SelectionPayload {
  /** Column-major 4×4 model-view-projection matrix */
  mvpMatrix: Float64Array
  /** Screen-space selection rectangle [x0, y0, x1, y1] in pixels */
  screenRect: [number, number, number, number]
  /** Viewport dimensions */
  viewportWidth: number
  viewportHeight: number
  /** Tiles to test — each entry has nodeId + positions buffer */
  tiles: SelectionTileInput[]
}

export interface SelectionTileInput {
  nodeId: string
  positions: Float32Array
  pointCount: number
}

export interface SelectionResponse {
  requestId: string
  type: 'result' | 'error'
  payload: SelectionResultPayload | string
  transfer?: ArrayBuffer[]
}

export interface SelectionResultPayload {
  tiles: SelectionTileResult[]
}

export interface SelectionTileResult {
  nodeId: string
  mask: Uint8Array
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

globalThis.onmessage = (e: MessageEvent<SelectionRequest>) => {
  const { requestId, type, payload } = e.data

  if (type !== 'select') {
    const resp: SelectionResponse = { requestId, type: 'error', payload: `Unknown type: ${type}` }
    globalThis.postMessage(resp)
    return
  }

  try {
    const result = processSelection(payload)
    const transferables: Transferable[] = []
    for (const tile of result.tiles) {
      transferables.push(tile.mask.buffer as ArrayBuffer)
    }
    const resp: SelectionResponse = { requestId, type: 'result', payload: result, transfer: transferables as ArrayBuffer[] }
    globalThis.postMessage(resp, { transfer: transferables })
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const resp: SelectionResponse = { requestId, type: 'error', payload: msg }
    globalThis.postMessage(resp)
  }
}

// ---------------------------------------------------------------------------
// Core selection logic — project each point, test against screen rect
// ---------------------------------------------------------------------------

function processSelection(payload: SelectionPayload): SelectionResultPayload {
  const { mvpMatrix: m, screenRect, viewportWidth: vw, viewportHeight: vh, tiles } = payload
  const [sx0, sy0, sx1, sy1] = screenRect

  // Normalize screen rect to NDC (-1..1) range
  const ndcX0 = (Math.min(sx0, sx1) / vw) * 2 - 1
  const ndcX1 = (Math.max(sx0, sx1) / vw) * 2 - 1
  const ndcY0 = 1 - (Math.max(sy0, sy1) / vh) * 2 // flip Y
  const ndcY1 = 1 - (Math.min(sy0, sy1) / vh) * 2

  const results: SelectionTileResult[] = []

  for (const tile of tiles) {
    const { nodeId, positions, pointCount } = tile
    const mask = new Uint8Array(pointCount)

    for (let i = 0; i < pointCount; i++) {
      const i3 = i * 3
      const x = positions[i3]!
      const y = positions[i3 + 1]!
      const z = positions[i3 + 2]!

      // Multiply by MVP (column-major)
      const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
      const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
      // const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! // not needed for 2D test
      const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!

      // Skip points behind camera
      if (cw <= 0)
        continue

      // Perspective divide → NDC
      const ndcX = cx / cw
      const ndcY = cy / cw

      // Test against selection rect in NDC
      if (ndcX >= ndcX0 && ndcX <= ndcX1 && ndcY >= ndcY0 && ndcY <= ndcY1) {
        mask[i] = 1
      }
    }

    results.push({ nodeId, mask })
  }

  return { tiles: results }
}
