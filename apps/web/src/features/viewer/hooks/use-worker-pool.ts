import type { DecodeTilePayload, TileData, WorkerRequest, WorkerResponse } from '../data/types'
import { useCallback, useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (data: TileData) => void
  reject: (error: Error) => void
}

interface PoolWorker {
  worker: Worker
  pending: number
  ready: boolean
  requestIds: Set<string>
}

interface UseWorkerPoolOptions {
  poolSize?: number
}

interface WorkerPool {
  decode: (payload: DecodeTilePayload) => Promise<TileData>
  terminate: () => void
  readonly poolSize: number
}

const DEFAULT_POOL_SIZE = typeof navigator !== 'undefined'
  ? Math.min(Math.max(navigator.hardwareConcurrency ?? 2, 2), 4)
  : 3

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWorkerPool(options?: UseWorkerPoolOptions): WorkerPool {
  const poolSize = options?.poolSize ?? DEFAULT_POOL_SIZE
  const workersRef = useRef<PoolWorker[]>([])
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map())
  const idCounterRef = useRef(0)
  const terminatedRef = useRef(false)

  // Initialize workers
  useEffect(() => {
    // Capture ref value for use in cleanup (React exhaustive-deps)
    const pending = pendingRef.current
    const workers: PoolWorker[] = []

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        new URL('../workers/decode.worker.ts', import.meta.url),
        { type: 'module' },
      )

      const poolWorker: PoolWorker = { worker, pending: 0, ready: false, requestIds: new Set() }

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { requestId, type, payload } = event.data
        const req = pending.get(requestId)

        if (!req)
          return

        if (type === 'result') {
          pending.delete(requestId)
          poolWorker.requestIds.delete(requestId)
          poolWorker.pending--

          // Check if this is an init response
          if ((payload as Record<string, unknown>).ready) {
            poolWorker.ready = true
            req.resolve(payload as unknown as TileData)
          }
          else {
            req.resolve(payload as TileData)
          }
        }
        else if (type === 'error') {
          pending.delete(requestId)
          poolWorker.requestIds.delete(requestId)
          poolWorker.pending--
          const msg = (payload as { message: string }).message
          req.reject(new Error(msg))
        }
        // 'progress' type is ignored for decode (no long-running progress)
      }

      worker.onerror = (event) => {
        event.preventDefault()
        // Reject only this worker's pending requests, not other workers'
        poolWorker.ready = false
        worker.terminate()
        for (const reqId of poolWorker.requestIds) {
          const req = pending.get(reqId)
          if (req) {
            pending.delete(reqId)
            req.reject(new Error('Worker crashed'))
          }
        }
        poolWorker.requestIds.clear()
        poolWorker.pending = 0
      }

      workers.push(poolWorker)

      // Send init message to pre-load WASM
      const initId = `init-${i}`
      const initReq: WorkerRequest = { requestId: initId, type: 'init', payload: {} }

      pending.set(initId, {
        resolve: () => { poolWorker.ready = true },
        reject: () => {},
      })
      poolWorker.requestIds.add(initId)
      poolWorker.pending++
      worker.postMessage(initReq)
    }

    workersRef.current = workers
    terminatedRef.current = false

    return () => {
      terminatedRef.current = true
      for (const pw of workers) {
        pw.worker.terminate()
      }
      workersRef.current = []
      for (const [, req] of pending) {
        req.reject(new Error('Worker pool terminated'))
      }
      pending.clear()
    }
  }, [poolSize])

  // Pick the least-busy worker
  const pickWorker = useCallback((): PoolWorker => {
    const workers = workersRef.current
    let best = workers[0]!
    for (let i = 1; i < workers.length; i++) {
      if (workers[i]!.pending < best.pending) {
        best = workers[i]!
      }
    }
    return best
  }, [])

  const decode = useCallback((payload: DecodeTilePayload): Promise<TileData> => {
    if (terminatedRef.current) {
      return Promise.reject(new Error('Worker pool terminated'))
    }

    return new Promise<TileData>((resolve, reject) => {
      const requestId = `decode-${++idCounterRef.current}`
      const poolWorker = pickWorker()

      pendingRef.current.set(requestId, { resolve, reject })
      poolWorker.requestIds.add(requestId)
      poolWorker.pending++

      const msg: WorkerRequest = {
        requestId,
        type: 'decode-tile',
        payload,
      }

      poolWorker.worker.postMessage(msg)
    })
  }, [pickWorker])

  const terminate = useCallback(() => {
    terminatedRef.current = true
    for (const pw of workersRef.current) {
      pw.worker.terminate()
    }
    workersRef.current = []
    for (const [, req] of pendingRef.current) {
      req.reject(new Error('Worker pool terminated'))
    }
    pendingRef.current.clear()
  }, [])

  return { decode, terminate, poolSize }
}
