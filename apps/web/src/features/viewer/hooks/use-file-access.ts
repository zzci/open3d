import type { DatasetDescriptor, FileAccessState, SourceFormat } from '../data/types'
import { useCallback, useRef, useState } from 'react'
import { LAS_MAGIC, POINT_FORMAT_ATTRIBUTES } from '../data/types'

const TRAILING_NULLS = /\0+$/

declare global {
  interface Window {
    showOpenFilePicker: (options?: {
      types?: Array<{
        description: string
        accept: Record<string, string[]>
      }>
      multiple?: boolean
    }) => Promise<FileSystemFileHandle[]>
  }
}

const ACCEPTED_EXTENSIONS = ['.las', '.laz', '.copc.las', '.copc.laz']

function supportsFileSystemAccess(): boolean {
  return 'showOpenFilePicker' in window
}

function readBytes(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer()
}

function decodeAscii(buffer: ArrayBuffer, offset: number, length: number): string {
  const bytes = new Uint8Array(buffer, offset, length)
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0)
      break
    result += String.fromCharCode(bytes[i])
  }
  return result
}

interface VlrHeader {
  userId: string
  recordId: number
  contentLength: number
  totalLength: number
}

function parseVlrHeader(view: DataView, offset: number): VlrHeader {
  const userId = decodeAscii(view.buffer as ArrayBuffer, offset + 2, 16)
  const recordId = view.getUint16(offset + 18, true)
  const contentLength = view.getUint16(offset + 20, true)
  return {
    userId,
    recordId,
    contentLength,
    totalLength: 54 + contentLength,
  }
}

interface LasHeader {
  versionMajor: number
  versionMinor: number
  headerSize: number
  offsetToPointData: number
  numVlrs: number
  pointFormat: number
  pointRecordLength: number
  pointCount: number
  scaleX: number
  scaleY: number
  scaleZ: number
  offsetX: number
  offsetY: number
  offsetZ: number
  maxX: number
  minX: number
  maxY: number
  minY: number
  maxZ: number
  minZ: number
}

async function parseLasHeader(file: File): Promise<LasHeader> {
  const headerBytes = await readBytes(file, 0, 375)
  const view = new DataView(headerBytes)

  const magic = decodeAscii(headerBytes, 0, 4)
  if (magic !== LAS_MAGIC) {
    throw new Error(`Not a LAS file: invalid magic bytes "${magic}"`)
  }

  const versionMajor = view.getUint8(24)
  const versionMinor = view.getUint8(25)
  const headerSize = view.getUint16(94, true)
  const offsetToPointData = view.getUint32(96, true)
  const numVlrs = view.getUint32(100, true)
  const pointFormat = view.getUint8(104)
  const pointRecordLength = view.getUint16(105, true)

  let pointCount: number
  if (versionMajor === 1 && versionMinor >= 4) {
    const lo = view.getUint32(247, true)
    const hi = view.getUint32(251, true)
    pointCount = hi * 0x100000000 + lo
  }
  else {
    pointCount = view.getUint32(107, true)
  }

  return {
    versionMajor,
    versionMinor,
    headerSize,
    offsetToPointData,
    numVlrs,
    pointFormat,
    pointRecordLength,
    pointCount,
    scaleX: view.getFloat64(131, true),
    scaleY: view.getFloat64(139, true),
    scaleZ: view.getFloat64(147, true),
    offsetX: view.getFloat64(155, true),
    offsetY: view.getFloat64(163, true),
    offsetZ: view.getFloat64(171, true),
    maxX: view.getFloat64(179, true),
    minX: view.getFloat64(187, true),
    maxY: view.getFloat64(195, true),
    minY: view.getFloat64(203, true),
    maxZ: view.getFloat64(211, true),
    minZ: view.getFloat64(219, true),
  }
}

interface VlrScanResult {
  hasCopc: boolean
  hasLaszip: boolean
  crs: string | undefined
  copcHierarchyDepth: number
}

async function scanVlrs(file: File, header: LasHeader): Promise<VlrScanResult> {
  const vlrRegionSize = header.offsetToPointData - header.headerSize
  if (vlrRegionSize <= 0 || header.numVlrs === 0) {
    return { hasCopc: false, hasLaszip: false, crs: undefined, copcHierarchyDepth: 0 }
  }

  const vlrBytes = await readBytes(file, header.headerSize, vlrRegionSize)
  const view = new DataView(vlrBytes)

  let hasCopc = false
  let hasLaszip = false
  let crs: string | undefined
  let copcHierarchyDepth = 0
  let offset = 0

  for (let i = 0; i < header.numVlrs && offset < vlrBytes.byteLength - 54; i++) {
    const vlr = parseVlrHeader(view, offset)
    const userIdTrimmed = vlr.userId.trim()

    if (userIdTrimmed === 'copc' && vlr.recordId === 1) {
      hasCopc = true
      if (vlr.contentLength >= 40) {
        const infoView = new DataView(vlrBytes, offset + 54, vlr.contentLength)
        const halfsize = infoView.getFloat64(24, true)
        copcHierarchyDepth = halfsize > 0 ? Math.ceil(Math.log2(halfsize)) : 0
      }
    }

    if (userIdTrimmed === 'laszip encoded' && vlr.recordId === 22204) {
      hasLaszip = true
    }

    if (userIdTrimmed === 'LASF_Projection' && vlr.recordId === 2112) {
      const wktBytes = new Uint8Array(vlrBytes, offset + 54, vlr.contentLength)
      crs = new TextDecoder().decode(wktBytes).replace(TRAILING_NULLS, '')
    }

    offset += vlr.totalLength
  }

  return { hasCopc, hasLaszip, crs, copcHierarchyDepth }
}

function detectFormat(
  fileName: string,
  header: LasHeader,
  vlrResult: VlrScanResult,
): SourceFormat {
  if (vlrResult.hasCopc)
    return 'copc'
  if (vlrResult.hasLaszip)
    return 'laz'
  if (fileName.toLowerCase().endsWith('.laz'))
    return 'laz'
  return 'las'
}

async function buildDescriptor(file: File): Promise<DatasetDescriptor> {
  const header = await parseLasHeader(file)
  const vlrResult = await scanVlrs(file, header)
  const format = detectFormat(file.name, header, vlrResult)

  const baseFormat = header.pointFormat > 127 ? header.pointFormat - 128 : header.pointFormat
  const attributes = POINT_FORMAT_ATTRIBUTES[baseFormat]
    ?? POINT_FORMAT_ATTRIBUTES[0]!

  return {
    id: crypto.randomUUID(),
    sourceFormat: format,
    fileName: file.name,
    fileSize: file.size,
    pointCount: header.pointCount,
    pointFormat: header.pointFormat,
    bounds: {
      min: [header.minX, header.minY, header.minZ],
      max: [header.maxX, header.maxY, header.maxZ],
    },
    scale: [header.scaleX, header.scaleY, header.scaleZ],
    offset: [header.offsetX, header.offsetY, header.offsetZ],
    attributes,
    crs: vlrResult.crs,
    hierarchyDepth: vlrResult.copcHierarchyDepth,
    rootNodeId: format === 'copc' ? '0-0-0-0' : '0-0-0-0',
    cached: false,
  }
}

function validateFileExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export function useFileAccess() {
  const [state, setState] = useState<FileAccessState>({
    isLoading: false,
    error: null,
    descriptor: null,
  })
  const inputRef = useRef<HTMLInputElement>(null)

  const processFile = useCallback(async (file: File) => {
    if (!validateFileExtension(file.name)) {
      setState({ isLoading: false, error: `Unsupported file type: ${file.name}. Expected .las, .laz, or .copc.las`, descriptor: null })
      return
    }

    setState({ isLoading: true, error: null, descriptor: null })
    try {
      const descriptor = await buildDescriptor(file)
      setState({ isLoading: false, error: null, descriptor })
    }
    catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file'
      setState({ isLoading: false, error: message, descriptor: null })
    }
  }, [])

  const openFilePicker = useCallback(async () => {
    if (!supportsFileSystemAccess()) {
      inputRef.current?.click()
      return
    }

    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'Point Cloud Files',
            accept: { 'application/octet-stream': ['.las', '.laz'] },
          },
        ],
        multiple: false,
      })
      const file = await handle.getFile()
      await processFile(file)
    }
    catch (err) {
      if (err instanceof Error && err.name === 'AbortError')
        return
      const message = err instanceof Error ? err.message : 'Failed to open file'
      setState(prev => ({ ...prev, error: message }))
    }
  }, [processFile])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer.files[0]
    if (file) {
      processFile(file)
    }
  }, [processFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      processFile(file)
    }
    if (e.target) {
      e.target.value = ''
    }
  }, [processFile])

  const reset = useCallback(() => {
    setState({ isLoading: false, error: null, descriptor: null })
  }, [])

  return {
    ...state,
    inputRef,
    supportsFilePicker: supportsFileSystemAccess(),
    openFilePicker,
    handleDrop,
    handleDragOver,
    handleInputChange,
    reset,
  }
}
