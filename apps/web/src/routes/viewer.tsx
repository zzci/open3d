/* eslint-disable style/max-statements-per-line */
import type { PointCloudData } from '@/features/viewer/renderer/deck-viewer'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DeckViewer, computeColors } from '@/features/viewer/renderer/deck-viewer'
import { applyOp, loadLAS, saveLAS } from '@/features/viewer/data/las-loader'
import type { EditOp } from '@/features/viewer/data/las-loader'

export const Route = createFileRoute('/viewer')({
  component: ViewerPage,
})

const MAX_PTS = [
  { v: 1000000, l: '1M' },
  { v: 3000000, l: '3M' },
  { v: 5000000, l: '5M' },
  { v: 10000000, l: '10M' },
  { v: 20000000, l: '20M' },
  { v: 0, l: 'All' },
]

const VIEWS = ['persp', 'top', 'bottom', 'front', 'back', 'right', 'left'] as const
const COLOR_MODES = [
  { v: 'rgb', l: 'RGB' },
  { v: 'intensity', l: 'Intensity' },
  { v: 'height', l: 'Height' },
  { v: 'heightIntensity', l: 'Height+Int' },
  { v: 'shading', l: 'Shading' },
  { v: 'edl', l: 'Warm Light' },
  { v: 'white', l: 'White' },
]

type InteractionMode = 'navigate' | 'select'
interface SelectionInfo { matrix: number[], rect: [number, number, number, number], vpWidth: number, vpHeight: number }

function ViewerPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<DeckViewer | null>(null)
  const rectRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({ active: false, sx: 0, sy: 0 })
  const fileRef = useRef<File | null>(null)
  const opsRef = useRef<EditOp[]>([])
  const baseDataRef = useRef<PointCloudData | null>(null)
  const selectionRef = useRef<SelectionInfo | null>(null)

  const [fileName, setFileName] = useState<string | null>(null)
  const [data, setData] = useState<PointCloudData | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadText, setLoadText] = useState('')
  const [progress, setProgress] = useState(0)
  const [toast, setToast] = useState<{ msg: string, type: string } | null>(null)
  const [pointSize, setPointSize] = useState(1)
  const [maxPoints, setMaxPoints] = useState(0) // 0 = all points, no downsampling
  const [colorMode, setColorMode] = useState('rgb')
  const [viewPreset, setViewPreset] = useState<string | null>('persp')
  const [mode, setMode] = useState<InteractionMode>('navigate')
  const [hasSelection, setHasSelection] = useState(false)
  const [selectedCount, setSelectedCount] = useState(0)
  const [totalPoints, setTotalPoints] = useState(0)
  const [editCount, setEditCount] = useState(0)

  const showToast = useCallback((msg: string, type = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
  }, [])

  // Init deck.gl
  useEffect(() => {
    if (!containerRef.current) return
    const viewer = new DeckViewer(containerRef.current, { colorMode, pointSizeMultiplier: pointSize })
    viewerRef.current = viewer
    return () => { viewer.dispose(); viewerRef.current = null }
  // eslint-disable-next-line react/exhaustive-deps
  }, [])

  // Sync settings
  useEffect(() => { viewerRef.current?.setColorMode(colorMode) }, [colorMode])
  useEffect(() => { viewerRef.current?.setPointSize(pointSize) }, [pointSize])
  useEffect(() => { viewerRef.current?.setController(mode === 'navigate') }, [mode])
  useEffect(() => { if (viewPreset) viewerRef.current?.setViewPreset(viewPreset) }, [viewPreset])

  // Re-derive display data by replaying all ops on base
  const deriveData = useCallback((base: PointCloudData, ops: EditOp[]): PointCloudData => {
    let d = base
    for (const op of ops) d = applyOp(d, op).result
    return d
  }, [])

  const doLoad = useCallback(async (file: File, mp: number) => {
    setLoading(true)
    setLoadText(`Loading ${file.name}...`)
    setProgress(0)
    try {
      const pd = await loadLAS(file, mp, (pct) => {
        setProgress(pct)
        setLoadText(`Loading... ${(pct * 100) | 0}%`)
      })
      baseDataRef.current = pd
      const derived = deriveData(pd, opsRef.current)
      setData(derived)
      setTotalPoints(pd.count)
      viewerRef.current?.setData(derived)
      setViewPreset('persp')
      return derived
    }
    finally {
      setLoading(false)
    }
  }, [deriveData])

  const handleFile = useCallback(async (file: File) => {
    fileRef.current = file
    opsRef.current = []
    setEditCount(0)
    selectionRef.current = null
    setHasSelection(false)
    setFileName(file.name)
    const pd = await doLoad(file, maxPoints)
    if (pd) showToast(`Loaded ${file.name} (${pd.count.toLocaleString()} pts)`, 'success')
  }, [maxPoints, doLoad, showToast])

  const handleMaxPointsChange = useCallback(async (v: number) => {
    setMaxPoints(v)
    if (fileRef.current) await doLoad(fileRef.current, v)
  }, [doLoad])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  // Selection
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode !== 'select' || e.button !== 0) return
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
    if (!dragRef.current.active) return
    const r = containerRef.current!.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    const rect = rectRef.current!
    rect.style.left = `${Math.min(dragRef.current.sx, cx)}px`
    rect.style.top = `${Math.min(dragRef.current.sy, cy)}px`
    rect.style.width = `${Math.abs(cx - dragRef.current.sx)}px`
    rect.style.height = `${Math.abs(cy - dragRef.current.sy)}px`
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    rectRef.current!.style.display = 'none'
    const viewer = viewerRef.current
    if (!data || !viewer) return
    const r = containerRef.current!.getBoundingClientRect()
    const cx = e.clientX - r.left, cy = e.clientY - r.top
    const L = Math.min(dragRef.current.sx, cx), T = Math.min(dragRef.current.sy, cy)
    const R = Math.max(dragRef.current.sx, cx), B = Math.max(dragRef.current.sy, cy)
    if (R - L < 5 || B - T < 5) return
    const m = viewer.getViewProjectionMatrix()
    if (!m) return
    const { width: vpW, height: vpH } = viewer.getViewportSize()
    const pos = data.positions, n = data.count
    const hl = new Uint8Array(n)
    let found = 0
    for (let i = 0; i < n; i++) {
      const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!
      const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!
      if (cw <= 0) continue
      const sx = ((m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / cw * 0.5 + 0.5) * vpW
      const sy = (0.5 - (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / cw * 0.5) * vpH
      if (sx >= L && sx <= R && sy >= T && sy <= B) { hl[i] = 1; found++ }
    }
    if (!found) return
    viewer.setHighlight(hl)
    setSelectedCount(found)
    setHasSelection(true)
    selectionRef.current = { matrix: m, rect: [L, T, R, B], vpWidth: vpW, vpHeight: vpH }
  }, [data, mode])

  const clearSelection = useCallback(() => {
    selectionRef.current = null
    setHasSelection(false)
    setSelectedCount(0)
    viewerRef.current?.setHighlight(null)
  }, [])

  // Delete/Keep
  const handleDelete = useCallback((keep: boolean) => {
    const sel = selectionRef.current
    if (!sel || !data) return
    const op: EditOp = { matrix: sel.matrix, rect: sel.rect, vpWidth: sel.vpWidth, vpHeight: sel.vpHeight, keepInside: keep }
    opsRef.current.push(op)
    const { result, removedCount } = applyOp(data, op)
    setData(result)
    viewerRef.current?.setHighlight(null)
    viewerRef.current?.setData(result)
    setEditCount(opsRef.current.length)
    showToast(`${keep ? 'Kept, removed' : 'Deleted'} ${removedCount.toLocaleString()} pts`, 'success')
    selectionRef.current = null
    setHasSelection(false)
  }, [data, showToast])

  // Undo
  const handleUndo = useCallback(() => {
    if (!opsRef.current.length || !baseDataRef.current) { showToast('Nothing to undo', 'info'); return }
    opsRef.current.pop()
    const derived = deriveData(baseDataRef.current, opsRef.current)
    setData(derived)
    viewerRef.current?.setData(derived)
    setEditCount(opsRef.current.length)
    showToast('Undone', 'success')
  }, [deriveData, showToast])

  // Save
  const handleSave = useCallback(async () => {
    const file = fileRef.current
    if (!file || !opsRef.current.length) { showToast('No edits', 'info'); return }
    setLoading(true)
    setLoadText('Saving...')
    try {
      const blob = await saveLAS(file, opsRef.current, (pct) => {
        setProgress(pct)
        setLoadText(`Saving... ${(pct * 100) | 0}%`)
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      a.download = fileName?.replace(/\.las$/i, `_${ts}.las`) || `edited_${ts}.las`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`Saved (${(blob.size / 1e6).toFixed(1)} MB)`, 'success')
    }
    catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Save failed', 'error')
    }
    finally {
      setLoading(false)
    }
  }, [fileName, showToast])

  // Auto color for grayscale
  useEffect(() => {
    if (data?.isGrayscale && colorMode === 'rgb') setColorMode('intensity')
  }, [data?.isGrayscale, colorMode])

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === 's' && !e.ctrlKey && !e.metaKey) { setMode(m => m === 'select' ? 'navigate' : 'select'); e.preventDefault() }
      if (e.key === 'Escape') clearSelection()
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { handleUndo(); e.preventDefault() }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); handleSave() }
      const vk: Record<string, string> = { 1: 'persp', 2: 'top', 3: 'bottom', 4: 'front', 5: 'right', 6: 'back', 7: 'left' }
      if (vk[e.key]) setViewPreset(vk[e.key]!)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [handleUndo, handleSave, clearSelection])

  // Global drag-drop
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); e.stopPropagation() }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const f = e.dataTransfer?.files[0]
      if (f && /\.la[sz]$/i.test(f.name)) handleFile(f)
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', drop) }
  }, [handleFile])

  return (
    <div className="relative h-screen w-screen bg-[#0d1117]">
      {/* deck.gl container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Selection interaction layer — sits above deck.gl canvas, blocks its controller */}
      {mode === 'select' && (
        <div
          className="absolute inset-0 z-10"
          style={{ cursor: 'crosshair' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        />
      )}
      <div ref={rectRef} className="pointer-events-none absolute z-10 border-2 border-blue-500 bg-blue-500/10" style={{ display: 'none' }} />

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex flex-col items-center gap-3 rounded-lg bg-[#161b22] px-8 py-6 text-white shadow-lg">
            <div className="text-sm">{loadText}</div>
            {progress > 0 && progress < 1 && (
              <div className="h-1.5 w-48 overflow-hidden rounded-full bg-[#30363d]">
                <div className="h-full rounded-full bg-[#58a6ff] transition-[width]" style={{ width: `${progress * 100}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toolbar — always visible, centered when no file */}
      <div className={`absolute z-20 flex items-center gap-2 rounded-lg bg-[#161b22]/90 px-3 py-1.5 text-xs text-[#c9d1d9] shadow-sm backdrop-blur-sm ${fileName ? 'left-1/2 top-3 -translate-x-1/2' : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'}`}>
        <label className="cursor-pointer rounded bg-[#21262d] px-2 py-1 text-[#c9d1d9] hover:bg-[#30363d]">
          {fileName || 'Open LAS'}
          <input type="file" accept=".las,.laz" className="hidden" onChange={handleInputChange} />
        </label>

        {fileName && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />

            {/* View presets */}
            {VIEWS.map(v => (
              <button key={v} className={`rounded px-1.5 py-0.5 ${viewPreset === v ? 'bg-[#58a6ff] text-white' : 'hover:bg-[#30363d]'}`} onClick={() => setViewPreset(v)}>
                {v}
              </button>
            ))}

            <div className="h-4 w-px bg-[#30363d]" />

            {/* Nav/Select mode */}
            <button className={`rounded px-2 py-0.5 ${mode === 'navigate' ? 'bg-[#30363d]' : 'hover:bg-[#30363d]'}`} onClick={() => setMode('navigate')}>Nav</button>
            <button className={`rounded px-2 py-0.5 ${mode === 'select' ? 'bg-[#d63384] text-white' : 'hover:bg-[#30363d]'}`} onClick={() => setMode('select')}>Sel</button>

            <div className="h-4 w-px bg-[#30363d]" />

            {/* Point size */}
            <span className="text-[#8b949e]">Size</span>
            <input type="range" min="0.1" max="5" step="0.1" value={pointSize} onChange={e => setPointSize(Number(e.target.value))} className="w-16" />
            <span className="tabular-nums text-[#8b949e]">{pointSize}</span>

            {/* Max points */}
            <span className="text-[#8b949e]">Pts</span>
            <select value={maxPoints} onChange={e => handleMaxPointsChange(Number(e.target.value))} className="rounded border border-[#30363d] bg-[#21262d] px-1 py-0.5 text-[#c9d1d9]">
              {MAX_PTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>

            {/* Color mode */}
            <select value={colorMode} onChange={e => setColorMode(e.target.value)} className="rounded border border-[#30363d] bg-[#21262d] px-1 py-0.5 text-[#c9d1d9]">
              {COLOR_MODES.map(m => <option key={m.v} value={m.v}>{data?.isGrayscale && m.v === 'rgb' ? 'Intensity' : m.l}</option>)}
            </select>

            <div className="flex-1" />

            {/* Selection actions */}
            {hasSelection && (
              <>
                <span className="text-[#ff9944]">~{selectedCount.toLocaleString()}</span>
                <button className="rounded bg-[#f85149] px-2 py-0.5 text-white" onClick={() => handleDelete(false)}>Delete</button>
                <button className="rounded bg-[#3fb950] px-2 py-0.5 text-white" onClick={() => handleDelete(true)}>Keep</button>
                <button className="rounded bg-[#30363d] px-2 py-0.5" onClick={clearSelection}>Esc</button>
              </>
            )}

            {/* Edit actions */}
            {editCount > 0 && <span className="text-[#ffcc44]">{editCount} edit{editCount > 1 ? 's' : ''}</span>}
            <button className="rounded bg-[#21262d] px-2 py-0.5 disabled:opacity-40" disabled={editCount === 0} onClick={handleUndo}>Undo</button>
            <button className="rounded bg-[#58a6ff] px-2 py-0.5 text-white disabled:opacity-40" disabled={!fileName || editCount === 0 || loading} onClick={handleSave}>Save</button>
          </>
        )}
      </div>

      {/* Status bar */}
      {fileName && (
        <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-3 rounded-lg bg-[#161b22]/90 px-4 py-1.5 text-xs text-[#8b949e] shadow-sm backdrop-blur-sm">
          <span>{fileName}</span>
          <span>Total: {totalPoints.toLocaleString()}</span>
          <span>Display: {data?.count.toLocaleString() || '-'}</span>
          {editCount > 0 && <span className="text-[#ffcc44]">Unsaved: {editCount}</span>}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`absolute left-1/2 top-14 z-50 -translate-x-1/2 rounded px-4 py-2 text-sm text-white shadow-lg ${
          toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-red-600' : 'bg-neutral-700'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
