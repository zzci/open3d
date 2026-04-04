/**
 * Export session orchestration.
 *
 * Coordinates between the export Worker, edit log, source data, and save dialog.
 * Handles File System Access API save picker with blob URL fallback.
 */

import type { DatasetDescriptor, WorkerResponse } from '../data/types'
import type { EditLogEntry } from './edit-log-types'

const FILE_EXTENSION_RE = /\.[^.]+$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportProgress {
  phase: 'counting' | 'writing' | 'finalizing'
  pointsProcessed: number
  totalPoints: number
  bytesWritten: number
}

export interface ExportSessionOptions {
  file: File
  descriptor: DatasetDescriptor
  editLog: EditLogEntry[]
  onProgress: (progress: ExportProgress) => void
  onComplete: (result: { pointCount: number, fileSize: number }) => void
  onError: (message: string) => void
}

// ---------------------------------------------------------------------------
// OPFS temp file access
// ---------------------------------------------------------------------------

async function getExportTempDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const cacheDir = await root.getDirectoryHandle('cache', { create: true })
  return cacheDir.getDirectoryHandle('export-tmp', { create: true })
}

async function readTempFile(name: string): Promise<File> {
  const dir = await getExportTempDir()
  const handle = await dir.getFileHandle(name)
  return handle.getFile()
}

async function deleteTempFile(name: string): Promise<void> {
  try {
    const dir = await getExportTempDir()
    await dir.removeEntry(name)
  }
  catch {
    // File may not exist
  }
}

// ---------------------------------------------------------------------------
// File save: File System Access API or blob URL fallback
// ---------------------------------------------------------------------------

async function saveWithPicker(tempFile: File, suggestedName: string): Promise<boolean> {
  if (!('showSaveFilePicker' in globalThis)) {
    return false
  }

  try {
    const handle = await (globalThis as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'LAS Point Cloud',
            accept: { 'application/octet-stream': ['.las'] },
          },
        ],
      })

    const writable = await handle.createWritable()

    // Stream from temp file in 1 MB chunks to avoid memory spike
    const CHUNK = 1_048_576
    let offset = 0
    while (offset < tempFile.size) {
      const end = Math.min(offset + CHUNK, tempFile.size)
      const chunk = await tempFile.slice(offset, end).arrayBuffer()
      await writable.write(chunk)
      offset = end
    }

    await writable.close()
    return true
  }
  catch (err: unknown) {
    // User cancelled the picker — not an error
    if (err instanceof DOMException && err.name === 'AbortError') {
      return true // User cancelled, but no error
    }
    return false
  }
}

function saveWithBlobUrl(tempFile: File, suggestedName: string): void {
  const url = URL.createObjectURL(tempFile)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()

  // Clean up after a short delay
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 1000)
}

// ---------------------------------------------------------------------------
// Export session
// ---------------------------------------------------------------------------

export class ExportSession {
  private worker: Worker | null = null
  private requestId = `export-${Date.now()}`
  private tempFileName = ''
  private aborted = false

  start(options: ExportSessionOptions): void {
    this.aborted = false
    this.worker = new Worker(
      new URL('../workers/export.worker.ts', import.meta.url),
      { type: 'module' },
    )

    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data

      if (msg.type === 'progress') {
        options.onProgress(msg.payload as ExportProgress)
      }
      else if (msg.type === 'result') {
        const result = msg.payload as { tempFileName: string, pointCount: number, fileSize: number }
        this.tempFileName = result.tempFileName
        this.handleSave(result, options)
      }
      else if (msg.type === 'error') {
        const err = msg.payload as { message: string }
        if (!this.aborted) {
          options.onError(err.message)
        }
        this.cleanup()
      }
    })

    this.worker.postMessage({
      requestId: this.requestId,
      type: 'export',
      payload: {
        file: options.file,
        descriptor: options.descriptor,
        editLog: options.editLog,
      },
    })
  }

  cancel(): void {
    this.aborted = true
    if (this.worker) {
      this.worker.postMessage({
        requestId: this.requestId,
        type: 'cancel',
        payload: null,
      })
    }
    this.cleanup()
  }

  private async handleSave(
    result: { tempFileName: string, pointCount: number, fileSize: number },
    options: ExportSessionOptions,
  ): Promise<void> {
    try {
      const tempFile = await readTempFile(result.tempFileName)
      const baseName = options.descriptor.fileName.replace(FILE_EXTENSION_RE, '')
      const suggestedName = `${baseName}-export.las`

      const saved = await saveWithPicker(tempFile, suggestedName)
      if (!saved) {
        // Fallback to blob URL download
        saveWithBlobUrl(tempFile, suggestedName)
      }

      options.onComplete({
        pointCount: result.pointCount,
        fileSize: result.fileSize,
      })
    }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save file'
      options.onError(message)
    }
    finally {
      await this.cleanupTemp()
      this.cleanup()
    }
  }

  private async cleanupTemp(): Promise<void> {
    if (this.tempFileName) {
      await deleteTempFile(this.tempFileName)
      this.tempFileName = ''
    }
  }

  private cleanup(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
  }
}
