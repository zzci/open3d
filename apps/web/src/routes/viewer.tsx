/* eslint-disable style/max-statements-per-line */
import type { PointCloudData } from '@/features/viewer/renderer/deck-viewer'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { loadLAS } from '@/features/viewer/data/las-loader'
import { DeckViewer } from '@/features/viewer/renderer/deck-viewer'

export const Route = createFileRoute('/viewer')({
  component: ViewerPage,
})

type InteractionMode = 'navigate' | 'select'

const COLOR_MODES = ['intensity', 'rgb', 'height', 'heightIntensity', 'white'] as const
const COLOR_LABELS: Record<string, string> = {
  intensity: 'Intensity',
  rgb: 'RGB',
  height: 'Height',
  heightIntensity: 'Height × Intensity',
  white: 'White',
}

function ViewerPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<DeckViewer | null>(null)
  const dataRef = useRef<PointCloudData | null>(null)
  const rectRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({ active: false, sx: 0, sy: 0 })

  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [fileName, setFileName] = useState('')
  const [pointCount, setPointCount] = useState(0)
  const [colorMode, setColorMode] = useState<string>('intensity')
  const [pointSize, setPointSize] = useState(1.0)
  const [mode, setMode] = useState<InteractionMode>('navigate')
  const [selectedCount, setSelectedCount] = useState(0)
  const [lastSelection, setLastSelection] = useState<{ matrix: number[], rect: [number, number, number, number], vpWidth: number, vpHeight: number } | null>(null)

  // Init deck.gl viewer
  useEffect(() => {
    if (!containerRef.current)
      return
    const viewer = new DeckViewer(containerRef.current, { colorMode, pointSizeMultiplier: pointSize })
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  useEffect(() => {
    viewerRef.current?.setColorMode(colorMode)
  }, [colorMode])
  useEffect(() => {
    viewerRef.current?.setPointSize(pointSize)
  }, [pointSize])
  useEffect(() => {
    viewerRef.current?.setController(mode === 'navigate')
  }, [mode])

  const handleFile = useCallback(async (file: File) => {
    setLoading(true)
    setProgress(0)
    setFileName(file.name)
    setSelectedCount(0)
    setLastSelection(null)
    try {
      const data = await loadLAS(file, 10_000_000, pct => setProgress(Math.round(pct * 100)))
      dataRef.current = data
      viewerRef.current?.setData(data)
      setPointCount(data.count)
      setLoaded(true)
    }
    catch (err) {
      console.error('Failed to load:', err)
    }
    finally {
      setLoading(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file)
      handleFile(file)
  }, [handleFile])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file)
      handleFile(file)
  }, [handleFile])

  // Selection
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode !== 'select' || e.button !== 0)
      return
    const r = containerRef.current!.getBoundingClientRect()
    dragRef.current = { active: true, sx: e.clientX - r.left, sy: e.clientY - r.top }
    const rect = rectRef.current!
    rect.style.display = 'block'
    rect.style.left = `${dragRef.current.sx}px`
    rect.style.top = `${dragRef.current.sy}px`
    rect.style.width = '0'
    rect.style.height = '0'
  }, [mode])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.active)
      return
    const r = containerRef.current!.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    const rect = rectRef.current!
    rect.style.left = `${Math.min(dragRef.current.sx, cx)}px`
    rect.style.top = `${Math.min(dragRef.current.sy, cy)}px`
    rect.style.width = `${Math.abs(cx - dragRef.current.sx)}px`
    rect.style.height = `${Math.abs(cy - dragRef.current.sy)}px`
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.active)
      return
    dragRef.current.active = false
    rectRef.current!.style.display = 'none'
    const data = dataRef.current
    const viewer = viewerRef.current
    if (!data || !viewer)
      return
    const r = containerRef.current!.getBoundingClientRect()
    const cx = e.clientX - r.left
    const cy = e.clientY - r.top
    const L = Math.min(dragRef.current.sx, cx)
    const T = Math.min(dragRef.current.sy, cy)
    const R = Math.max(dragRef.current.sx, cx)
    const B = Math.max(dragRef.current.sy, cy)
    if (R - L < 5 || B - T < 5)
      return
    const m = viewer.getViewProjectionMatrix()
    if (!m)
      return
    const { width: vpW, height: vpH } = viewer.getViewportSize()
    const pos = data.positions
    const hl = new Uint8Array(data.count)
    let found = 0
    for (let i = 0; i < data.count; i++) {
      const px = pos[i * 3]!; const py = pos[i * 3 + 1]!; const pz = pos[i * 3 + 2]!
      const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!
      if (cw <= 0)
        continue
      const sx = ((m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / cw * 0.5 + 0.5) * vpW
      const sy = (0.5 - (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / cw * 0.5) * vpH
      if (sx >= L && sx <= R && sy >= T && sy <= B) {
        hl[i] = 1
        found++
      }
    }
    if (!found)
      return
    viewer.setHighlight(hl)
    setSelectedCount(found)
    setLastSelection({ matrix: m, rect: [L, T, R, B], vpWidth: vpW, vpHeight: vpH })
  }, [mode])

  // Edit
  const handleDelete = useCallback((keepInside: boolean) => {
    const data = dataRef.current
    const viewer = viewerRef.current
    const sel = lastSelection
    if (!data || !viewer || !sel)
      return
    const { matrix: m, rect: [L, T, R, B], vpWidth: w, vpHeight: h } = sel
    const pos = data.positions
    const n = data.count
    let removed = 0
    const bitmap = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const px = pos[i * 3]!; const py = pos[i * 3 + 1]!; const pz = pos[i * 3 + 2]!
      const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!
      if (cw <= 0) {
        if (keepInside) { bitmap[i] = 1; removed++ }
        continue
      }
      const sx = ((m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / cw * 0.5 + 0.5) * w
      const sy = (0.5 - (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / cw * 0.5) * h
      const inside = sx >= L && sx <= R && sy >= T && sy <= B
      if (keepInside ? !inside : inside) { bitmap[i] = 1; removed++ }
    }
    if (removed === 0)
      return
    const nn = n - removed
    const np = new Float32Array(nn * 3)
    const nc = new Uint8Array(nn * 3)
    const ni = new Uint8Array(nn)
    let j = 0
    for (let i = 0; i < n; i++) {
      if (bitmap[i])
        continue
      np[j * 3] = data.positions[i * 3]!
      np[j * 3 + 1] = data.positions[i * 3 + 1]!
      np[j * 3 + 2] = data.positions[i * 3 + 2]!
      nc[j * 3] = data.colors[i * 3]!
      nc[j * 3 + 1] = data.colors[i * 3 + 1]!
      nc[j * 3 + 2] = data.colors[i * 3 + 2]!
      ni[j] = data.intensity[i]!
      j++
    }
    const newData: PointCloudData = { positions: np, colors: nc, intensity: ni, count: nn, bounds: data.bounds, avgSpacing: data.avgSpacing, isGrayscale: data.isGrayscale }
    dataRef.current = newData
    viewer.setHighlight(null)
    viewer.setData(newData)
    setPointCount(nn)
    setSelectedCount(0)
    setLastSelection(null)
  }, [lastSelection])

  const handleClear = useCallback(() => {
    viewerRef.current?.setHighlight(null)
    setSelectedCount(0)
    setLastSelection(null)
  }, [])

  return (
    <div className="relative h-screen w-screen">
      {/* deck.gl container — always mounted so useEffect can init Deck */}
      <div ref={containerRef} className="absolute inset-0" style={{ cursor: mode === 'select' ? 'crosshair' : 'default' }} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} />
      <div ref={rectRef} className="pointer-events-none absolute border-2 border-blue-500 bg-blue-500/10" style={{ display: 'none' }} />

      {/* File opener overlay */}
      {!loaded && !loading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-neutral-100" onDrop={handleDrop} onDragOver={e => e.preventDefault()}>
          <div className="flex flex-col items-center gap-4 rounded-lg border-2 border-dashed border-neutral-300 p-12">
            <h1 className="text-2xl font-bold text-neutral-700">Open3D Point Cloud Viewer</h1>
            <p className="text-sm text-neutral-500">Drag & drop a .las file, or click to browse</p>
            <label className="cursor-pointer rounded bg-neutral-800 px-6 py-2 text-sm text-white hover:bg-neutral-700">
              Browse Files
              <input type="file" accept=".las,.laz" className="hidden" onChange={handleInputChange} />
            </label>
          </div>
        </div>
      )}

      {loading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/80">
          <div className="flex flex-col items-center gap-3">
            <div className="text-lg font-medium">
              Loading
              {' '}
              {fileName}
              ...
            </div>
            <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-200">
              <div className="h-full rounded-full bg-neutral-800 transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <div className="text-sm text-neutral-500">
              {progress}
              %
            </div>
          </div>
        </div>
      )}
      {loaded && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-white/90 px-4 py-2 shadow-sm backdrop-blur-sm">
          <select className="rounded border px-2 py-1 text-xs" value={colorMode} onChange={e => setColorMode(e.target.value)}>
            {COLOR_MODES.map(m => <option key={m} value={m}>{COLOR_LABELS[m]}</option>)}
          </select>
          <div className="h-4 w-px bg-neutral-300" />
          <label className="flex items-center gap-1 text-xs text-neutral-600">
            Size
            <input type="range" min="0.3" max="3" step="0.1" value={pointSize} onChange={e => setPointSize(Number(e.target.value))} className="w-16" />
          </label>
          <div className="h-4 w-px bg-neutral-300" />
          <button className={`rounded px-3 py-1 text-xs ${mode === 'select' ? 'bg-blue-600 text-white' : 'bg-neutral-200'}`} onClick={() => setMode(mode === 'navigate' ? 'select' : 'navigate')}>
            {mode === 'select' ? 'Select Mode' : 'Navigate'}
          </button>
          {selectedCount > 0 && (
            <>
              <span className="text-xs text-neutral-500">
                {selectedCount.toLocaleString()}
                {' '}
                pts
              </span>
              <button className="rounded bg-red-600 px-2 py-1 text-xs text-white" onClick={() => handleDelete(false)}>Delete</button>
              <button className="rounded bg-green-600 px-2 py-1 text-xs text-white" onClick={() => handleDelete(true)}>Keep</button>
              <button className="rounded bg-neutral-200 px-2 py-1 text-xs" onClick={handleClear}>Clear</button>
            </>
          )}
          <div className="h-4 w-px bg-neutral-300" />
          <label className="cursor-pointer rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300">
            Open
            <input type="file" accept=".las,.laz" className="hidden" onChange={handleInputChange} />
          </label>
        </div>
      )}
      {loaded && (
        <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-lg bg-white/90 px-4 py-1.5 text-xs text-neutral-600 shadow-sm backdrop-blur-sm">
          {fileName}
          {' '}
          ·
          {pointCount.toLocaleString()}
          {' '}
          points
        </div>
      )}
    </div>
  )
}
