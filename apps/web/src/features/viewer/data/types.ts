export type SourceFormat = 'copc' | 'las' | 'laz'

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface DatasetDescriptor {
  id: string
  sourceFormat: SourceFormat
  fileName: string
  fileSize: number
  pointCount: number
  pointFormat: number
  bounds: Bounds
  scale: [number, number, number]
  offset: [number, number, number]
  attributes: string[]
  crs?: string
  hierarchyDepth: number
  rootNodeId: string
  cached: boolean
}

export interface FileAccessResult {
  file: File
  descriptor: DatasetDescriptor
}

export interface FileAccessState {
  isLoading: boolean
  error: string | null
  descriptor: DatasetDescriptor | null
  file: File | null
}

// --- Octree hierarchy types ---

export interface OctreeNode {
  id: string // COPC key "D-X-Y-Z"
  level: number
  bounds: Bounds
  pointCount: number
  childMask: number // bitmask of which children exist (0-255)
  byteOffset: number
  byteSize: number
}

// --- Worker communication protocol ---

export interface WorkerRequest {
  requestId: string
  type: string
  payload: unknown
}

export interface WorkerResponse {
  requestId: string
  type: 'result' | 'progress' | 'error'
  payload: unknown
  transfer?: ArrayBuffer[]
}

// --- Metadata worker specific messages ---

export interface ParseMetadataPayload {
  file: File
}

export interface MetadataResult {
  descriptor: DatasetDescriptor
  hierarchy: OctreeNode[]
}

export interface ProgressPayload {
  phase: string
  percent: number
}

// --- Constants ---

export const LAS_MAGIC = 'LASF'

export interface TileData {
  nodeId: string
  level: number
  pointCount: number
  bounds: Bounds
  spacing?: number // meters — node spacing for adaptive point sizing
  positions: Float32Array
  colors?: Uint8Array
  intensity?: Float32Array
  intensityEqualized?: Float32Array
  classification?: Uint8Array
  returnNumber?: Uint8Array
  numberOfReturns?: Uint8Array
  scanAngle?: Float32Array
  userData?: Uint8Array
  pointSourceId?: Uint16Array
  gpsTime?: Float64Array
  nir?: Uint16Array
  classificationFlags?: Uint8Array
  scannerChannel?: Uint8Array
}

// --- Decode worker specific messages ---

export interface DecodeTilePayload {
  file: File
  nodeId: string
  level: number
  byteOffset: number
  byteSize: number
  pointCount: number
  bounds: Bounds
  pointFormat: number
  pointRecordLength: number
  scale: [number, number, number]
  offset: [number, number, number]
}

// --- Indexing worker specific messages ---

export interface IndexingPayload {
  file: File
  datasetId: string
}

export interface IndexingProgress {
  pointsProcessed: number
  totalPoints: number
  phase: string
  estimatedRemaining: number // ms, -1 if unknown
}

export interface IndexingResult {
  descriptor: DatasetDescriptor
  hierarchy: OctreeNode[]
}

export const POINT_FORMAT_ATTRIBUTES: Record<number, string[]> = {
  0: ['x', 'y', 'z', 'intensity', 'return_number', 'classification'],
  1: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time'],
  2: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'red', 'green', 'blue'],
  3: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue'],
  6: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time'],
  7: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue'],
  8: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue', 'nir'],
}
