/* eslint-disable style/max-statements-per-line */
import type { PointCloudData } from '@/features/viewer/renderer/deck-viewer'
import type { EditOp } from '@/features/viewer/data/las-loader'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DeckViewer } from '@/features/viewer/renderer/deck-viewer'
import { applyOp, loadLAS } from '@/features/viewer/data/las-loader'
import { loadPLY } from '@/features/viewer/data/ply-loader'
import { useI18n } from '@/features/viewer/hooks/use-i18n'
import { saveFilteredLAS } from '@/features/viewer/data/las-saver'

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
const VIEW_KEYS = { persp: 'persp', top: 'top', bottom: 'bottom', front: 'front', back: 'back', right: 'right', left: 'left' } as const
const COLOR_MODE_KEYS = [
  { v: 'rgb', k: 'rgb' },
  { v: 'intensity', k: 'intensity' },
  { v: 'height', k: 'height' },
  { v: 'heightIntensity', k: 'heightInt' },
  { v: 'shading', k: 'shading' },
  { v: 'edl', k: 'warmLight' },
  { v: 'white', k: 'white' },
] as const

type InteractionMode = 'navigate' | 'select' | 'eraser'
interface SelectionInfo { bitmap: Uint8Array, selectedCount: number, m: Float64Array, rect: [number, number, number, number] }

/**
 * Fast inline projection: viewProjectionMatrix × point → screen pixel coords.
 * Three.js MVP outputs NDC [-1,1], we convert to pixel coords.
 */
function projectToScreen(m: Float64Array, vpW: number, vpH: number, px: number, py: number, pz: number): { sx: number, sy: number } | null {
  const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!
  if (cw <= 0) return null
  const invW = 1 / cw
  const ndcX = (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) * invW
  const ndcY = (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) * invW
  return {
    sx: (ndcX * 0.5 + 0.5) * vpW,
    sy: (0.5 - ndcY * 0.5) * vpH,
  }
}

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
  const [maxPoints, setMaxPoints] = useState(5000000) // 0 = all points, no downsampling
  const [colorMode, setColorMode] = useState('rgb')
  const [viewPreset, setViewPreset] = useState<string | null>('persp')
  const [mode, setMode] = useState<InteractionMode>('navigate')
  const [hasSelection, setHasSelection] = useState(false)
  const [selectedCount, setSelectedCount] = useState(0)
  const [totalPoints, setTotalPoints] = useState(0)
  const [editCount, setEditCount] = useState(0)
  const { t, toggle: toggleLang, lang } = useI18n()
  const [eraserSize, setEraserSize] = useState(20) // pixel radius
  const [eraserPos, setEraserPos] = useState<{ x: number, y: number } | null>(null)
  const erasingRef = useRef(false)

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
    setLoadText(`${t('loading')} ${file.name}...`)
    setProgress(0)
    try {
      const onPct = (pct: number) => {
        setProgress(pct)
        setLoadText(`${t('loading')}... ${(pct * 100) | 0}%`)
      }
      const isPly = file.name.toLowerCase().endsWith('.ply')
      const pd = isPly
        ? await loadPLY(file, mp, onPct)
        : await loadLAS(file, mp, onPct)
      baseDataRef.current = pd
      const derived = deriveData(pd, opsRef.current)
      setData(derived)
      setTotalPoints(pd.count)
      viewerRef.current?.updateData(derived)
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
    if (pd) showToast(`${t('loaded')} ${file.name} (${pd.count.toLocaleString()} ${t('pts_suffix')})`, 'success')
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
    const pm = viewer.getPixelProjectionMatrix()
    if (!pm) return
    const { width: vpW, height: vpH } = viewer.getViewportSize()
    const pos = data.positions, n = data.count
    const hl = new Uint8Array(n)
    let found = 0
    for (let i = 0; i < n; i++) {
      const p = projectToScreen(pm, vpW, vpH, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
      if (p && p.sx >= L && p.sx <= R && p.sy >= T && p.sy <= B) { hl[i] = 1; found++ }
    }
    if (!found) return
    viewer.setHighlight(hl)
    setSelectedCount(found)
    setHasSelection(true)
    selectionRef.current = { bitmap: hl, selectedCount: found, m: pm, rect: [L, T, R, B] }
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
    const { bitmap: selBitmap } = sel
    const n = data.count

    // Use stored selection bitmap — no re-projection needed
    // keep=false: delete selected (bitmap=1), keep=true: delete unselected (bitmap=0)
    let removed = 0
    const deleteBitmap = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const shouldDelete = keep ? !selBitmap[i] : !!selBitmap[i]
      if (shouldDelete) { deleteBitmap[i] = 1; removed++ }
    }
    if (removed === 0) return

    const nn = n - removed
    const np = new Float32Array(nn * 3)
    const nc = new Uint8Array(nn * 3)
    const ni = new Uint8Array(nn)
    let j = 0
    for (let i = 0; i < n; i++) {
      if (deleteBitmap[i]) continue
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

    // Store EditOp for save replay — use viewProjectionMatrix (NDC), not pixelProjectionMatrix
    const vpSize = viewerRef.current?.getViewportSize()
    const vpm = viewerRef.current?.getViewProjectionMatrix()
    if (vpm && vpSize) {
      const op: EditOp = { matrix: vpm, rect: sel.rect, vpWidth: vpSize.width, vpHeight: vpSize.height, keepInside: keep }
      opsRef.current.push(op)
    }

    setData(newData)
    viewerRef.current?.setHighlight(null)
    viewerRef.current?.updateData(newData)
    setEditCount(opsRef.current.length)
    showToast(`${keep ? t('keptRemoved') : t('deleted')} ${removed.toLocaleString()} ${t('pts_suffix')}`, 'success')
    selectionRef.current = null
    setHasSelection(false)
  }, [data, showToast])

  // Undo
  const handleUndo = useCallback(() => {
    if (!opsRef.current.length || !baseDataRef.current) { showToast(t('nothingToUndo'), 'info'); return }
    opsRef.current.pop()
    const derived = deriveData(baseDataRef.current, opsRef.current)
    setData(derived)
    viewerRef.current?.updateData(derived)
    setEditCount(opsRef.current.length)
    showToast(t('undone'), 'success')
  }, [deriveData, showToast])

  // Eraser — removes points within radius of cursor position
  const eraseAtPosition = useCallback((cx: number, cy: number) => {
    const viewer = viewerRef.current
    if (!data || !viewer) return
    const pm = viewer.getPixelProjectionMatrix()
    if (!pm) return
    const { width: vpW, height: vpH } = viewer.getViewportSize()
    if (!pm) return

    const r2 = eraserSize * eraserSize
    const pos = data.positions, n = data.count
    let removed = 0
    const bitmap = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const p = projectToScreen(pm, vpW, vpH, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
      if (p) {
        const dx = p.sx - cx, dy = p.sy - cy
        if (dx * dx + dy * dy <= r2) { bitmap[i] = 1; removed++ }
      }
    }
    if (removed === 0) return

    const nn = n - removed
    const np = new Float32Array(nn * 3)
    const nc = new Uint8Array(nn * 3)
    const ni = new Uint8Array(nn)
    let j = 0
    for (let i = 0; i < n; i++) {
      if (bitmap[i]) continue
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

    // Push as undo-able op (circular erase uses a dummy rect)
    const vpSize = viewer.getViewportSize()
    const op: EditOp = { matrix: Array.from(pm), rect: [cx - eraserSize, cy - eraserSize, cx + eraserSize, cy + eraserSize], vpWidth: vpSize.width, vpHeight: vpSize.height, keepInside: false }
    opsRef.current.push(op)

    setData(newData)
    viewer.updateData(newData)
    setEditCount(opsRef.current.length)
  }, [data, eraserSize])

  const onEraserDown = useCallback((e: React.MouseEvent) => {
    if (mode !== 'eraser' || e.button !== 0) return
    erasingRef.current = true
    const r = containerRef.current!.getBoundingClientRect()
    eraseAtPosition(e.clientX - r.left, e.clientY - r.top)
  }, [mode, eraseAtPosition])

  const onEraserMove = useCallback((e: React.MouseEvent) => {
    if (mode !== 'eraser') return
    const r = containerRef.current!.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    setEraserPos({ x, y })
    if (erasingRef.current) {
      eraseAtPosition(x, y)
    }
  }, [mode, eraseAtPosition])

  const onEraserUp = useCallback(() => {
    if (erasingRef.current) {
      erasingRef.current = false
      showToast(`${t('erased')} (${editCount + 1} ${t('edits')})`, 'success')
    }
  }, [editCount, showToast])

  // Save — generate blob first (with progress), then prompt user to pick save location
  const handleSave = useCallback(async () => {
    const file = fileRef.current
    const base = baseDataRef.current
    if (!file || !data || !base || data.count === base.count) { showToast(t('noEdits'), 'info'); return }

    // Block save if data was downsampled — would silently lose unsampled points
    if (maxPoints > 0 && base.count < totalPoints) {
      showToast(t('saveRequiresAll'), 'error')
      return
    }

    // Step 1: Generate the filtered LAS blob (show progress)
    setLoading(true)
    setLoadText(`${t('saving')}...`)
    let blob: Blob
    try {
      const kept = new Set<string>()
      const dp = data.positions
      for (let i = 0; i < data.count; i++) {
        kept.add(`${(dp[i * 3]! * 1000) | 0},${(dp[i * 3 + 1]! * 1000) | 0},${(dp[i * 3 + 2]! * 1000) | 0}`)
      }

      blob = await saveFilteredLAS(file, kept, (pct) => {
        setProgress(pct)
        setLoadText(`${t('saving')}... ${(pct * 100) | 0}%`)
      })
    }
    catch (e: unknown) {
      console.error('Save failed:', e)
      showToast(e instanceof Error ? e.message : t('saveFailed'), 'error')
      setLoading(false)
      return
    }
    setLoading(false)

    // Step 2: Prompt user to save (user gesture from clicking "confirm" or auto-trigger)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const baseName = (fileName || 'edited').replace(/\.las$/i, '').replace(/_\d{4}-\d{2}-\d{2}T[\d-]+$/, '')
    const suggestedName = `${baseName}_${ts}.las`

    try {
      if ('showSaveFilePicker' in window) {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName,
          types: [{ description: 'LAS Point Cloud', accept: { 'application/octet-stream': ['.las'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        showToast(`${t('saved')} ${suggestedName} (${(blob.size / 1e6).toFixed(1)} MB)`, 'success')
      }
      else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = suggestedName
        a.click()
        URL.revokeObjectURL(url)
        showToast(`${t('saved')} (${(blob.size / 1e6).toFixed(1)} MB)`, 'success')
      }
    }
    catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      showToast(t('saveFailed'), 'error')
    }
  }, [data, fileName, showToast, t])



  // Auto color for grayscale
  useEffect(() => {
    if (data?.isGrayscale && colorMode === 'rgb') setColorMode('intensity')
  }, [data?.isGrayscale, colorMode])

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === 's' && !e.ctrlKey && !e.metaKey) { setMode(m => m === 'select' ? 'navigate' : 'select'); e.preventDefault() }
      if (e.key === 'e' && !e.ctrlKey && !e.metaKey) { setMode(m => m === 'eraser' ? 'navigate' : 'eraser'); e.preventDefault() }
      if (e.key === 'Escape') { clearSelection(); setMode('navigate') }
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
      if (f && /\.las|.ply$/i.test(f.name)) handleFile(f)
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', drop) }
  }, [handleFile])

  return (
    <div className="relative h-screen w-screen ">
      {/* deck.gl container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Selection interaction layer */}
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

      {/* Eraser interaction layer */}
      {mode === 'eraser' && (
        <div
          className="absolute inset-0 z-10"
          style={{ cursor: 'none' }}
          onMouseDown={onEraserDown}
          onMouseMove={onEraserMove}
          onMouseUp={onEraserUp}
          onMouseLeave={() => { erasingRef.current = false; setEraserPos(null) }}
        />
      )}
      {/* Eraser cursor circle */}
      {mode === 'eraser' && eraserPos && (
        <div
          className="pointer-events-none absolute z-10 rounded-full border-2 border-red-500"
          style={{
            left: eraserPos.x - eraserSize,
            top: eraserPos.y - eraserSize,
            width: eraserSize * 2,
            height: eraserSize * 2,
          }}
        />
      )}

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
      <div className={`absolute z-20 flex flex-nowrap items-center gap-2 whitespace-nowrap rounded-lg bg-[#161b22]/90 px-3 py-1.5 text-xs text-[#c9d1d9] shadow-sm backdrop-blur-sm ${fileName ? 'left-3 right-3 top-3' : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'}`}>
        <label className="cursor-pointer rounded bg-[#21262d] px-2 py-1 text-[#c9d1d9] hover:bg-[#30363d]">
          Open
          <input type="file" accept=".las,.ply" className="hidden" onChange={handleInputChange} />
        </label>

        {fileName && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />

            {/* View presets */}
            {VIEWS.map(v => (
              <button key={v} className={`rounded px-1.5 py-0.5 ${viewPreset === v ? 'bg-[#58a6ff] text-white' : 'hover:bg-[#30363d]'}`} onClick={() => setViewPreset(v)}>
                {t(VIEW_KEYS[v])}
              </button>
            ))}

            <div className="h-4 w-px bg-[#30363d]" />

            {/* Nav/Select/Eraser mode */}
            <button className={`rounded px-2 py-0.5 ${mode === 'navigate' ? 'bg-[#30363d]' : 'hover:bg-[#30363d]'}`} onClick={() => setMode('navigate')}>{t('nav')}</button>
            <button className={`rounded px-2 py-0.5 ${mode === 'select' ? 'bg-[#d63384] text-white' : 'hover:bg-[#30363d]'}`} onClick={() => setMode('select')}>{t('sel')}</button>
            <button className={`rounded px-2 py-0.5 ${mode === 'eraser' ? 'bg-[#f85149] text-white' : 'hover:bg-[#30363d]'}`} onClick={() => setMode(mode === 'eraser' ? 'navigate' : 'eraser')}>{t('eraser')}</button>
            {mode === 'eraser' && (
              <>
                <input type="range" min="5" max="100" step="5" value={eraserSize} onChange={e => setEraserSize(Number(e.target.value))} className="w-14" />
                <span className="tabular-nums text-[#8b949e]">{eraserSize}px</span>
              </>
            )}

            <div className="h-4 w-px bg-[#30363d]" />

            {/* Point size */}
            <span className="text-[#8b949e]">Size</span>
            <input type="range" min="0.1" max="40" step="0.1" value={pointSize} onChange={e => setPointSize(Number(e.target.value))} className="w-16" />
            <span className="tabular-nums text-[#8b949e]">{pointSize}</span>

            {/* Max points */}
            <span className="text-[#8b949e]">Pts</span>
            <select value={maxPoints} onChange={e => handleMaxPointsChange(Number(e.target.value))} className="rounded border border-[#30363d] bg-[#21262d] px-1 py-0.5 text-[#c9d1d9]">
              {MAX_PTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>

            {/* Color mode */}
            <select value={colorMode} onChange={e => setColorMode(e.target.value)} className="rounded border border-[#30363d] bg-[#21262d] px-1 py-0.5 text-[#c9d1d9]">
              {COLOR_MODE_KEYS.map(m => <option key={m.v} value={m.v}>{data?.isGrayscale && m.v === 'rgb' ? t('intensity') : t(m.k)}</option>)}
            </select>

            <div className="flex-1" />

            {/* Selection actions */}
            {hasSelection && (
              <>
                <span className="text-[#ff9944]">~{selectedCount.toLocaleString()}</span>
                <button className="rounded bg-[#f85149] px-2 py-0.5 text-white" onClick={() => handleDelete(false)}>{t('delete')}</button>
                <button className="rounded bg-[#3fb950] px-2 py-0.5 text-white" onClick={() => handleDelete(true)}>{t('keep')}</button>
                <button className="rounded bg-[#30363d] px-2 py-0.5" onClick={clearSelection}>{t('clear')}</button>
              </>
            )}

            {/* Edit actions */}
            {editCount > 0 && <span className="text-[#ffcc44]">{editCount} {t('edits')}</span>}
            <button className="rounded bg-[#21262d] px-2 py-0.5 disabled:opacity-40" disabled={editCount === 0} onClick={handleUndo}>{t('undo')}</button>
            <button className="rounded bg-[#58a6ff] px-2 py-0.5 text-white disabled:opacity-40" disabled={!fileName || editCount === 0 || loading} onClick={handleSave}>{t('save')}</button>
          </>
        )}
        <div className="h-4 w-px bg-[#30363d]" />
        <button className="rounded bg-[#21262d] px-2 py-0.5 hover:bg-[#30363d]" onClick={toggleLang}>{t('lang')}</button>
      </div>

      {/* Status bar */}
      {fileName && (
        <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-3 rounded-lg bg-[#161b22]/90 px-4 py-1.5 text-xs text-[#8b949e] shadow-sm backdrop-blur-sm">
          <span>{fileName}</span>
          <span>{t('total')}: {totalPoints.toLocaleString()}</span>
          <span>{t('display')}: {data?.count.toLocaleString() || '-'}</span>
          {editCount > 0 && <span className="text-[#ffcc44]">{t('unsaved')}: {editCount}</span>}
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
