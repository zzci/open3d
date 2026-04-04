import type { Getter, Hierarchy } from 'copc'
import type { DatasetDescriptor, OctreeNode } from './types'
import { Copc, Bounds as CopcBounds, Key } from 'copc'
import { computeChildMask } from './hierarchy'
import { POINT_FORMAT_ATTRIBUTES } from './types'

/**
 * Create a copc.js Getter from a File object.
 * Performs byte-range reads via File.slice().
 */
export function createFileGetter(file: File): Getter {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const blob = file.slice(begin, end)
    const buffer = await blob.arrayBuffer()
    return new Uint8Array(buffer)
  }
}

export interface CopcParseResult {
  descriptor: DatasetDescriptor
  hierarchy: Map<string, OctreeNode>
}

/**
 * Parse a COPC file: header, VLRs, info, and full hierarchy.
 * Returns a DatasetDescriptor and a Map of all OctreeNodes keyed by "D-X-Y-Z".
 */
export async function parseCopc(
  file: File,
  onProgress?: (phase: string, percent: number) => void,
): Promise<CopcParseResult> {
  const getter = createFileGetter(file)

  onProgress?.('header', 0)
  const copc = await Copc.create(getter)
  onProgress?.('header', 100)

  // Walk the full hierarchy starting from root page
  onProgress?.('hierarchy', 0)
  const hierarchy = await walkHierarchy(getter, copc.info.rootHierarchyPage, copc.info.cube)
  onProgress?.('hierarchy', 100)

  const descriptor = buildDescriptor(file, copc, hierarchy)

  return { descriptor, hierarchy }
}

/**
 * Recursively walk all hierarchy pages to build the full octree.
 */
async function walkHierarchy(
  getter: Getter,
  rootPage: Hierarchy.Page,
  cube: CopcBounds,
): Promise<Map<string, OctreeNode>> {
  const result = new Map<string, OctreeNode>()
  const pageQueue: Hierarchy.Page[] = [rootPage]

  while (pageQueue.length > 0) {
    const page = pageQueue.pop()!
    const subtree = await Copc.loadHierarchyPage(getter, page)

    // Process nodes
    for (const [keyStr, node] of Object.entries(subtree.nodes)) {
      if (!node)
        continue
      const key = Key.create(keyStr)
      const bounds = CopcBounds.stepTo(cube, key)

      result.set(keyStr, {
        id: keyStr,
        level: key[0],
        bounds: {
          min: [bounds[0], bounds[1], bounds[2]],
          max: [bounds[3], bounds[4], bounds[5]],
        },
        pointCount: node.pointCount,
        childMask: 0, // computed after all nodes are collected
        byteOffset: node.pointDataOffset,
        byteSize: node.pointDataLength,
      })
    }

    // Queue sub-pages for further traversal
    for (const [, subPage] of Object.entries(subtree.pages)) {
      if (subPage) {
        pageQueue.push(subPage)
      }
    }
  }

  // Compute child masks now that we have all nodes
  computeChildMask(result)

  return result
}

function buildDescriptor(
  file: File,
  copc: Copc,
  hierarchy: Map<string, OctreeNode>,
): DatasetDescriptor {
  const { header, wkt } = copc
  const pointFormat = header.pointDataRecordFormat
  const attributes = POINT_FORMAT_ATTRIBUTES[pointFormat] ?? ['x', 'y', 'z']

  let maxDepth = 0
  for (const node of hierarchy.values()) {
    if (node.level > maxDepth)
      maxDepth = node.level
  }

  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    sourceFormat: 'copc',
    fileName: file.name,
    fileSize: file.size,
    pointCount: header.pointCount,
    pointFormat,
    bounds: {
      min: [header.min[0], header.min[1], header.min[2]],
      max: [header.max[0], header.max[1], header.max[2]],
    },
    scale: [header.scale[0], header.scale[1], header.scale[2]],
    offset: [header.offset[0], header.offset[1], header.offset[2]],
    attributes,
    crs: wkt,
    hierarchyDepth: maxDepth,
    rootNodeId: '0-0-0-0',
    cached: false,
  }
}
