import type { MetadataResult, ProgressPayload, WorkerRequest, WorkerResponse } from '../data/types'
import { parseCopc } from '../data/copc-reader'
import { serializeHierarchy } from '../data/hierarchy'

function respond(msg: Omit<WorkerResponse, 'transfer'>): void {
  globalThis.postMessage(msg)
}

function respondWithTransfer(msg: WorkerResponse, transfer: Transferable[]): void {
  globalThis.postMessage(msg, { transfer })
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload } = event.data

  if (type !== 'parse-metadata') {
    respond({
      requestId,
      type: 'error',
      payload: { message: `Unknown request type: ${type}` },
    })
    return
  }

  try {
    const { file } = payload as { file: File }

    const result = await parseCopc(file, (phase, percent) => {
      const progress: ProgressPayload = { phase, percent }
      respond({ requestId, type: 'progress', payload: progress })
    })

    const metadataResult: MetadataResult = {
      descriptor: result.descriptor,
      hierarchy: serializeHierarchy(result.hierarchy),
    }

    respondWithTransfer(
      { requestId, type: 'result', payload: metadataResult },
      [], // hierarchy is plain objects, no ArrayBuffer to transfer
    )
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    respond({ requestId, type: 'error', payload: { message } })
  }
}
