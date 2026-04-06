import { useState, useCallback, useEffect, useRef } from 'react'
import Viewer, { type SelectionInfo, type ViewerHandle } from './components/Viewer'
import { loadLAS, applyOp, saveLAS, type PointData, type EditOp } from './las'
import './App.css'

const MAX_PTS = [
  { v: 500000, l: '500K' }, { v: 1000000, l: '1M' }, { v: 2000000, l: '2M' },
  { v: 3000000, l: '3M' }, { v: 5000000, l: '5M' }, { v: 8000000, l: '8M' },
]
const VIEWS = ['persp','top','bottom','front','back','right','left']

export default function App() {
  const fileRef = useRef<File|null>(null)
  const viewerRef = useRef<ViewerHandle>(null)
  // Edit ops stack — undo pops last op and re-derives display from base
  const opsRef = useRef<EditOp[]>([])
  const baseDataRef = useRef<PointData|null>(null) // original loaded data (no edits)
  const selectionRef = useRef<SelectionInfo|null>(null)

  const [fileName, setFileName] = useState<string|null>(null)
  const [data, setData] = useState<PointData|null>(null)
  const [loading, setLoading] = useState(false)
  const [loadText, setLoadText] = useState('')
  const [progress, setProgress] = useState(0)
  const [toast, setToast] = useState<{msg:string;type:string}|null>(null)
  const [pointSize, setPointSize] = useState(1.0) // multiplier of real avg spacing
  const [maxPoints, setMaxPoints] = useState(3000000)
  const [colorMode, setColorMode] = useState('rgb')
  const [viewPreset, setViewPreset] = useState<string|null>('persp')
  const [interactionMode, setMode] = useState<'navigate'|'select'>('navigate')
  const [hasSelection, setHasSelection] = useState(false)
  const [selectedCount, setSelectedCount] = useState(0)
  const [totalPoints, setTotalPoints] = useState(0)
  const [editCount, setEditCount] = useState(0)

  const showToast = useCallback((msg:string,type='info')=>{
    setToast({msg,type});setTimeout(()=>setToast(null),2500)
  },[])

  // Re-derive display data by replaying all ops on base
  const deriveData = useCallback((base: PointData, ops: EditOp[]): PointData => {
    let d = base
    for (const op of ops) { d = applyOp(d, op).result }
    return d
  }, [])

  const doLoad = useCallback(async (file: File, mp: number) => {
    setLoading(true); setLoadText(`Loading ${file.name}...`); setProgress(0)
    try {
      const pd = await loadLAS(file, mp, pct => { setProgress(pct); setLoadText(`Loading... ${(pct*100)|0}%`) })
      baseDataRef.current = pd
      const derived = deriveData(pd, opsRef.current)
      setData(derived)
      setTotalPoints(pd.count)
      setViewPreset('persp')
      return derived
    } finally { setLoading(false) }
  }, [deriveData])

  const handleFile = useCallback(async (file: File) => {
    fileRef.current = file
    opsRef.current = []; setEditCount(0)
    selectionRef.current = null; setHasSelection(false)
    setFileName(file.name)
    const pd = await doLoad(file, maxPoints)
    if (pd) showToast(`Loaded ${file.name} (${pd.count.toLocaleString()} pts)`, 'success')
  }, [maxPoints, doLoad, showToast])

  const handleMaxPointsChange = useCallback(async (v: number) => {
    setMaxPoints(v)
    if (fileRef.current) {
      // Re-load base at new resolution, ops stay
      await doLoad(fileRef.current, v)
    }
  }, [doLoad])

  const handleSelect = useCallback((info: SelectionInfo, count: number) => {
    selectionRef.current = info; setHasSelection(true); setSelectedCount(count)
  }, [])

  const clearSelection = useCallback(() => {
    selectionRef.current = null; setHasSelection(false); setSelectedCount(0)
    viewerRef.current?.clearHighlight()
  }, [])

  // Delete/Keep — instant, no PointData snapshot needed for undo
  const handleDelete = useCallback((keep: boolean) => {
    const sel = selectionRef.current; if (!sel || !data) return
    const op: EditOp = { matrix:sel.matrix, rect:sel.rect, vpWidth:sel.vpWidth, vpHeight:sel.vpHeight, keepInside:keep }
    opsRef.current.push(op)
    // Apply just this one op to current display
    const { result, removedCount } = applyOp(data, op)
    setData(result)
    setEditCount(opsRef.current.length)
    showToast(`${keep?'Kept, removed':'Deleted'} ${removedCount.toLocaleString()} pts`,'success')
    selectionRef.current = null; setHasSelection(false)
  }, [data, showToast])

  // Undo — pop last op, replay remaining ops on base data (no snapshot storage)
  const handleUndo = useCallback(() => {
    if (!opsRef.current.length || !baseDataRef.current) { showToast('Nothing to undo','info'); return }
    opsRef.current.pop()
    setData(deriveData(baseDataRef.current, opsRef.current))
    setEditCount(opsRef.current.length)
    showToast('Undone','success')
  }, [deriveData, showToast])

  const handleSave = useCallback(async () => {
    const file = fileRef.current
    if (!file || !opsRef.current.length) { showToast('No edits','info'); return }
    setLoading(true); setLoadText('Saving...')
    try {
      const blob = await saveLAS(file, opsRef.current, pct => {
        setProgress(pct); setLoadText(`Saving... ${(pct*100)|0}%`)
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url
      a.download = fileName?.replace('.las','_edited.las') || 'edited.las'
      a.click(); URL.revokeObjectURL(url)
      showToast(`Saved (${(blob.size/1e6).toFixed(1)} MB)`,'success')
    } catch (e: any) { showToast(e.message,'error') }
    finally { setLoading(false) }
  }, [fileName, showToast])

  // Drag & drop
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); e.stopPropagation() }
    const drop = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer?.files[0]; if (f && /\.la[sz]$/i.test(f.name)) handleFile(f) }
    window.addEventListener('dragover', prevent); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', drop) }
  }, [handleFile])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (['INPUT','SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key==='s'&&!e.ctrlKey&&!e.metaKey) { setMode(m=>m==='select'?'navigate':'select'); e.preventDefault() }
      if (e.key==='Escape') clearSelection()
      if ((e.ctrlKey||e.metaKey)&&e.key==='z') { handleUndo(); e.preventDefault() }
      if ((e.ctrlKey||e.metaKey)&&e.key==='s') { e.preventDefault(); handleSave() }
      const vk:Record<string,string>={'1':'persp','2':'top','3':'bottom','4':'front','5':'right','6':'back','7':'left'}
      if (vk[e.key]) setViewPreset(vk[e.key])
    }
    window.addEventListener('keydown',h); return ()=>window.removeEventListener('keydown',h)
  },[handleUndo,handleSave,clearSelection])

  // Auto color for grayscale
  useEffect(()=>{if(data?.isGrayscale&&colorMode==='rgb')setColorMode('heightIntensity')},[data?.isGrayscale])

  return (
    <div className="app">
      <div className="toolbar">
        <div className="tb-group">
          <label className="tb-btn" style={{cursor:'pointer'}}>
            {fileName||'Open LAS'}
            <input type="file" accept=".las,.laz" style={{display:'none'}} onChange={e=>{const f=e.target.files?.[0];if(f)handleFile(f)}}/>
          </label>
        </div>
        <div className="tb-sep"/>
        <div className="tb-group">
          {VIEWS.map(v=><button key={v} className={`tb-btn sm ${viewPreset===v?'active':''}`} onClick={()=>setViewPreset(v)}>{v}</button>)}
        </div>
        <div className="tb-sep"/>
        <div className="tb-group">
          <button className={`tb-btn sm ${interactionMode==='navigate'?'active':''}`} onClick={()=>setMode('navigate')}>Nav</button>
          <button className={`tb-btn sm ${interactionMode==='select'?'active':''}`} onClick={()=>setMode('select')}>Sel</button>
        </div>
        <div className="tb-sep"/>
        <div className="tb-group" style={{gap:4}}>
          <span className="tb-label">Size</span>
          <input type="range" min="0.5" max="5" step="0.1" value={pointSize} onChange={e=>setPointSize(+e.target.value)} style={{width:80}}/>
          <span className="tb-val">{pointSize}x{data?` (${(data.avgSpacing*pointSize*1000).toFixed(1)}mm)`:''}</span>
        </div>
        <div className="tb-group" style={{gap:4}}>
          <span className="tb-label">Pts</span>
          <select value={maxPoints} onChange={e=>handleMaxPointsChange(+e.target.value)} className="tb-select">
            {MAX_PTS.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </div>
        <div className="tb-group" style={{gap:4}}>
          <span className="tb-label">Color</span>
          <select value={colorMode} onChange={e=>setColorMode(e.target.value)} className="tb-select">
            <option value="rgb">{data?.isGrayscale?'Intensity':'RGB'}</option>
            <option value="intensity">Intensity</option>
            <option value="height">Height</option>
            <option value="heightIntensity">Height+Int</option>
            <option value="edl">Warm Light</option>
            <option value="white">White</option>
          </select>
        </div>
        <div className="spacer"/>
        {hasSelection&&(
          <div className="tb-group">
            <span className="tb-label" style={{color:'#ff9944'}}>~{selectedCount.toLocaleString()}</span>
            <button className="tb-btn action danger" onClick={()=>handleDelete(false)}>Delete</button>
            <button className="tb-btn action primary" onClick={()=>handleDelete(true)}>Keep</button>
            <button className="tb-btn sm" onClick={clearSelection}>Esc</button>
          </div>
        )}
        <div className="tb-group">
          {editCount>0&&<span className="tb-label" style={{color:'#ffcc44'}}>{editCount} edit{editCount>1?'s':''}</span>}
          <button className="tb-btn action warn" disabled={editCount===0} onClick={handleUndo}>Undo</button>
          <button className="tb-btn action success" disabled={!fileName||editCount===0||loading} onClick={handleSave}>Save</button>
        </div>
      </div>

      {loading&&progress>0&&progress<1&&(
        <div className="progress-bar"><div className="progress-fill" style={{width:`${progress*100}%`}}/></div>
      )}

      <div className="statusbar">
        <span>{fileName||'Drag & drop .las file or click Open'}</span>
        <span>Total: {totalPoints.toLocaleString()}</span>
        <span>Display: {data?.count.toLocaleString()||'-'}</span>
        {editCount>0&&<span style={{color:'#ffcc44'}}>Unsaved: {editCount}</span>}
      </div>

      <Viewer ref={viewerRef} data={data} pointSize={pointSize}
        colorMode={colorMode} interactionMode={interactionMode}
        viewPreset={viewPreset} onSelect={handleSelect}/>

      {loading&&<div className="loading-overlay"><div className="spinner"/><span>{loadText}</span></div>}
      {toast&&<div className={`toast ${toast.type}`}>{toast.msg}</div>}
      {!fileName&&!loading&&(
        <div className="drop-hint"><div className="drop-icon">📂</div><div>Drag & drop .las file</div><div className="drop-sub">or click "Open LAS"</div></div>
      )}
    </div>
  )
}
