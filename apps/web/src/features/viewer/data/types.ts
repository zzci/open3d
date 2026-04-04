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
}

export const LAS_MAGIC = 'LASF'

export const POINT_FORMAT_ATTRIBUTES: Record<number, string[]> = {
  0: ['x', 'y', 'z', 'intensity', 'return_number', 'classification'],
  1: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time'],
  2: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'red', 'green', 'blue'],
  3: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue'],
  6: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time'],
  7: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue'],
  8: ['x', 'y', 'z', 'intensity', 'return_number', 'classification', 'gps_time', 'red', 'green', 'blue', 'nir'],
}
