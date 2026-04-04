/**
 * OPFS (Origin Private File System) cache for tile binary data.
 *
 * Directory structure:
 *   cache/datasets/{datasetId}/metadata.json
 *   cache/datasets/{datasetId}/hierarchy.bin
 *   cache/datasets/{datasetId}/tiles/{nodeId}.bin
 */

let opfsSupported: boolean | null = null

export async function isOpfsAvailable(): Promise<boolean> {
  if (opfsSupported !== null)
    return opfsSupported

  try {
    const root = await navigator.storage.getDirectory()
    // Probe write capability
    const probe = await root.getDirectoryHandle('__probe__', { create: true })
    await root.removeEntry('__probe__')
    void probe
    opfsSupported = true
  }
  catch {
    opfsSupported = false
  }

  return opfsSupported
}

async function getDatasetDir(
  datasetId: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const cacheDir = await root.getDirectoryHandle('cache', { create })
  const datasetsDir = await cacheDir.getDirectoryHandle('datasets', { create })
  return datasetsDir.getDirectoryHandle(datasetId, { create })
}

async function getTilesDir(
  datasetId: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const dsDir = await getDatasetDir(datasetId, create)
  return dsDir.getDirectoryHandle('tiles', { create })
}

export async function writeTile(
  datasetId: string,
  nodeId: string,
  data: ArrayBuffer,
): Promise<void> {
  const tilesDir = await getTilesDir(datasetId, true)
  const fileHandle = await tilesDir.getFileHandle(`${nodeId}.bin`, {
    create: true,
  })
  const writable = await fileHandle.createWritable()
  await writable.write(data)
  await writable.close()
}

export async function readTile(
  datasetId: string,
  nodeId: string,
): Promise<ArrayBuffer | null> {
  try {
    const tilesDir = await getTilesDir(datasetId)
    const fileHandle = await tilesDir.getFileHandle(`${nodeId}.bin`)
    const file = await fileHandle.getFile()
    return file.arrayBuffer()
  }
  catch {
    return null
  }
}

export async function writeMetadata(
  datasetId: string,
  metadata: unknown,
): Promise<void> {
  const dsDir = await getDatasetDir(datasetId, true)
  const fileHandle = await dsDir.getFileHandle('metadata.json', {
    create: true,
  })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(metadata))
  await writable.close()
}

export async function readMetadata<T = unknown>(
  datasetId: string,
): Promise<T | null> {
  try {
    const dsDir = await getDatasetDir(datasetId)
    const fileHandle = await dsDir.getFileHandle('metadata.json')
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text()) as T
  }
  catch {
    return null
  }
}

export async function writeHierarchy(
  datasetId: string,
  data: ArrayBuffer,
): Promise<void> {
  const dsDir = await getDatasetDir(datasetId, true)
  const fileHandle = await dsDir.getFileHandle('hierarchy.bin', {
    create: true,
  })
  const writable = await fileHandle.createWritable()
  await writable.write(data)
  await writable.close()
}

export async function readHierarchy(
  datasetId: string,
): Promise<ArrayBuffer | null> {
  try {
    const dsDir = await getDatasetDir(datasetId)
    const fileHandle = await dsDir.getFileHandle('hierarchy.bin')
    const file = await fileHandle.getFile()
    return file.arrayBuffer()
  }
  catch {
    return null
  }
}

export async function datasetCacheExists(
  datasetId: string,
): Promise<boolean> {
  try {
    await getDatasetDir(datasetId)
    return true
  }
  catch {
    return false
  }
}

async function removeDirRecursive(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await parent.removeEntry(name, { recursive: true })
}

export async function deleteDatasetCache(
  datasetId: string,
): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const cacheDir = await root.getDirectoryHandle('cache')
    const datasetsDir = await cacheDir.getDirectoryHandle('datasets')
    await removeDirRecursive(datasetsDir, datasetId)
  }
  catch {
    // Dataset cache doesn't exist — nothing to delete
  }
}

export async function getDatasetCacheSize(
  datasetId: string,
): Promise<number> {
  let total = 0

  try {
    const dsDir = await getDatasetDir(datasetId)
    total += await dirSize(dsDir)
  }
  catch {
    // Dataset doesn't exist
  }

  return total
}

async function dirSize(dir: FileSystemDirectoryHandle): Promise<number> {
  let size = 0

  // Use values() via cast — the async iterable API is available at runtime
  // in browsers supporting OPFS but not yet in all TS lib typings.
  const iter = (dir as unknown as AsyncIterable<FileSystemHandle>)[
    Symbol.asyncIterator
  ]()

  for (;;) {
    const { done, value } = await iter.next()
    if (done)
      break

    if (value.kind === 'file') {
      const file = await (value as FileSystemFileHandle).getFile()
      size += file.size
    }
    else {
      size += await dirSize(value as FileSystemDirectoryHandle)
    }
  }

  return size
}
