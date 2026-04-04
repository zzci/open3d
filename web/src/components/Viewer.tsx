import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Deck, OrbitView } from '@deck.gl/core'
import { PointCloudLayer, LineLayer } from '@deck.gl/layers'
import type { PointData } from '../las'

export interface SelectionInfo {
  matrix: number[]
  rect: [number, number, number, number]
  vpWidth: number; vpHeight: number
}
export interface ViewerHandle { clearHighlight: () => void }

interface Props {
  data: PointData | null
  pointSize: number
  colorMode: string
  interactionMode: 'navigate' | 'select'
  viewPreset: string | null
  onSelect: (info: SelectionInfo, count: number) => void
}

// ── Color generation (LUT-based, no per-point function calls) ──

function autoContrast(vals: Uint8Array, n: number): [number,number] {
  const hist=new Uint32Array(256)
  for(let i=0;i<n;i++)hist[vals[i]]++
  let cum=0,lo=0,hi=255; const lo2=n*.02
  for(let i=0;i<256;i++){cum+=hist[i];if(cum>=lo2){lo=i;break}}
  cum=0;for(let i=255;i>=0;i--){cum+=hist[i];if(cum>=n*.02){hi=i;break}}
  return[lo,Math.max(lo+1,hi)]
}

function hsl2rgb(h:number,s:number,l:number):[number,number,number]{
  if(!s)return[l,l,l]
  const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q
  const f=(t:number)=>{if(t<0)t++;if(t>1)t--;return t<1/6?p+(q-p)*6*t:t<.5?q:t<2/3?p+(q-p)*(2/3-t)*6:p}
  return[f(h+1/3),f(h),f(h-1/3)]
}

// Writes directly into `out` — no intermediate array allocation
function makeColors(data: PointData, mode: string, out: Uint8Array): void {
  const {positions:pos,colors:rgb,intensity:int,count:n,isGrayscale}=data

  if(mode==='rgb'&&!isGrayscale){out.set(rgb.subarray(0,n*3));return}

  if(mode==='rgb'||mode==='intensity'){
    // Auto-contrast with gamma curve for better shadow detail
    const[lo,hi]=autoContrast(int,n);const r=hi-lo
    for(let i=0;i<n;i++){
      const t=Math.min(1,Math.max(0,(int[i]-lo)/r))
      // Gamma 0.7 brightens midtones; floor at 30 so nothing disappears on light bg
      const v=(30+Math.pow(t,0.7)*225)|0
      out[i*3]=v;out[i*3+1]=v;out[i*3+2]=v
    }
    return
  }
  if(mode==='height'){
    // Bright rainbow: blue→cyan→green→yellow→red
    let zMin=1e30,zMax=-1e30
    for(let i=0;i<n;i++){const z=pos[i*3+2];if(z<zMin)zMin=z;if(z>zMax)zMax=z}
    const r=zMax-zMin||1
    for(let i=0;i<n;i++){
      const t=(pos[i*3+2]-zMin)/r
      // Brighter heatmap
      out[i*3]  =((Math.min(1,Math.max(0,1.5-Math.abs(t-.75)*4))*255)|0)
      out[i*3+1]=((Math.min(1,Math.max(0,1.5-Math.abs(t-.5)*4))*255)|0)
      out[i*3+2]=((Math.min(1,Math.max(0,1.5-Math.abs(t-.25)*4))*255)|0)
    }
    return
  }
  if(mode==='heightIntensity'){
    // Height → hue, intensity → lightness. Much brighter than before.
    let zMin=1e30,zMax=-1e30
    for(let i=0;i<n;i++){const z=pos[i*3+2];if(z<zMin)zMin=z;if(z>zMax)zMax=z}
    const zR=zMax-zMin||1
    const[iLo,iHi]=autoContrast(int,n);const iR=iHi-iLo
    // LUT at full brightness, then modulate by intensity
    const lutR=new Uint8Array(256),lutG=new Uint8Array(256),lutB=new Uint8Array(256)
    for(let h=0;h<256;h++){
      const[r,g,b]=hsl2rgb(h/255*.7,.85,.55) // high saturation, medium-high lightness
      lutR[h]=(r*255)|0;lutG[h]=(g*255)|0;lutB[h]=(b*255)|0
    }
    for(let i=0;i<n;i++){
      const hIdx=Math.min(255,Math.max(0,((pos[i*3+2]-zMin)/zR*255)|0))
      // intensity modulates brightness: 0.4 to 1.0 (never fully dark)
      const bright=0.4+0.6*Math.min(1,Math.max(0,(int[i]-iLo)/iR))
      out[i*3]=(lutR[hIdx]*bright)|0;out[i*3+1]=(lutG[hIdx]*bright)|0;out[i*3+2]=(lutB[hIdx]*bright)|0
    }
    return
  }
  if(mode==='edl'){
    // Warm/cool tone: bright warm highlights, cool blue shadows
    const[iLo,iHi]=autoContrast(int,n);const iR=iHi-iLo
    for(let i=0;i<n;i++){
      const t=Math.min(1,Math.max(0,(int[i]-iLo)/iR))
      // warm white highlights → cool blue shadows
      out[i*3]  =((0.3+t*0.7)*255)|0           // R: 77-255
      out[i*3+1]=((0.3+t*0.65)*255)|0          // G: 77-242
      out[i*3+2]=((0.4+(1-t)*0.2+t*0.4)*255)|0 // B: always some blue
    }
    return
  }
  // white
  for(let i=0;i<n*3;i++)out[i]=255
}

// ── Viewer ──

export default forwardRef<ViewerHandle,Props>(function Viewer(
  {data,pointSize,colorMode,interactionMode,viewPreset,onSelect},ref
){
  const containerRef=useRef<HTMLDivElement>(null)
  const deckRef=useRef<Deck|null>(null)
  const bufsRef=useRef<{colors:Uint8Array,normals:Float32Array,count:number}|null>(null)
  const highlightRef=useRef<Uint8Array|null>(null)
  const boundsRef=useRef({xn:0,xx:0,yn:0,yx:0,zn:0,zx:0})
  const vsRef=useRef<any>({target:[0,0,0],rotationX:30,rotationOrbit:-30,zoom:1,minZoom:-10,maxZoom:20})

  function ensureBufs(count:number){
    const b=bufsRef.current
    if(b&&b.count===count) return b
    const nb={colors:new Uint8Array(count*3),normals:new Float32Array(count*3),count}
    bufsRef.current=nb; return nb
  }

  /** Build grid lines + axis lines from current bounds */
  function buildGridData(){
    const {xn,xx,yn,yx,zn}=boundsRef.current
    const lines:{s:number[],t:number[],c:number[]}[]=[]
    // Determine grid spacing: aim for ~10-20 lines per axis
    const rangeX=xx-xn, rangeY=yx-yn
    const maxRange=Math.max(rangeX,rangeY)||10
    const rawStep=maxRange/15
    // Round to nice number
    const mag=Math.pow(10,Math.floor(Math.log10(rawStep)))
    const steps=[1,2,5,10]
    let gridStep=mag
    for(const s of steps){if(mag*s>=rawStep){gridStep=mag*s;break}}

    const gxn=Math.floor(xn/gridStep)*gridStep, gxx=Math.ceil(xx/gridStep)*gridStep
    const gyn=Math.floor(yn/gridStep)*gridStep, gyx=Math.ceil(yx/gridStep)*gridStep
    const gridColor=[180,182,185] // Rhino-style subtle grid on light bg

    // X lines (along Y)
    for(let x=gxn;x<=gxx;x+=gridStep){
      const isOrigin=Math.abs(x)<gridStep*0.01
      lines.push({s:[x,gyn,zn],t:[x,gyx,zn],c:isOrigin?[180,80,80]:gridColor})
    }
    // Y lines (along X)
    for(let y=gyn;y<=gyx;y+=gridStep){
      const isOrigin=Math.abs(y)<gridStep*0.01
      lines.push({s:[gxn,y,zn],t:[gxx,y,zn],c:isOrigin?[80,160,80]:gridColor})
    }

    // Axis lines (thicker, colored)
    const axLen=maxRange*0.15
    const axes=[
      {s:[0,0,zn],t:[axLen,0,zn],c:[220,60,60]},   // X red
      {s:[0,0,zn],t:[0,axLen,zn],c:[60,200,60]},    // Y green
      {s:[0,0,zn],t:[0,0,zn+axLen],c:[60,100,220]}, // Z blue
    ]

    return {lines,axes,gridStep}
  }

  useEffect(()=>{
    const dk=new Deck({
      parent:containerRef.current!,views:new OrbitView({orbitAxis:'Z'}),
      initialViewState:vsRef.current,controller:true,
      parameters:{depthTest:true, clearColor:[0.86,0.87,0.88,1]}, // Rhino3D light gray
      onViewStateChange:({viewState}:any)=>{vsRef.current=viewState;return viewState},
      layers:[],style:{position:'absolute',inset:'0'},
    })
    deckRef.current=dk;return()=>dk.finalize()
  },[])

  const pushLayer=useCallback(()=>{
    if(!deckRef.current||!data) return
    const b=ensureBufs(data.count)
    const {lines,axes}=buildGridData()
    const layers:any[]=[
      // Grid
      new LineLayer({
        id:'grid',data:lines,
        getSourcePosition:(d:any)=>d.s,getTargetPosition:(d:any)=>d.t,
        getColor:(d:any)=>d.c,getWidth:1,widthUnits:'pixels' as const,
      }),
      // Axes
      new LineLayer({
        id:'axes',data:axes,
        getSourcePosition:(d:any)=>d.s,getTargetPosition:(d:any)=>d.t,
        getColor:(d:any)=>d.c,getWidth:3,widthUnits:'pixels' as const,
      }),
      // Points
      new PointCloudLayer({
        id:'pts',
        data:{length:data.count,attributes:{
          getPosition:{value:data.positions,size:3},
          getColor:{value:b.colors,size:3},
          getNormal:{value:b.normals,size:3},
        }},
        pointSize: data.avgSpacing * pointSize, // pointSize is a multiplier of real spacing
        sizeUnits:'meters' as any,
        material:false,
      }),
    ]
    deckRef.current.setProps({layers})
  },[data,pointSize])

  // Apply highlight on top of current colors
  function applyHighlight(){
    if(!data||!highlightRef.current) return
    const b=ensureBufs(data.count), hl=highlightRef.current
    for(let i=0;i<data.count;i++){
      if(hl[i]){b.colors[i*3]=255;b.colors[i*3+1]=100;b.colors[i*3+2]=25}
    }
  }

  function recomputeColors(){
    if(!data) return
    const b=ensureBufs(data.count)
    makeColors(data,colorMode,b.colors)
    applyHighlight()
  }

  // Data changed — compute bounds, fit camera, recolor
  useEffect(()=>{
    if(!data||!deckRef.current)return
    highlightRef.current=null
    const {xn,xx,yn,yx,zn,zx}=data.bounds
    boundsRef.current=data.bounds
    const bSize=Math.max(xx-xn,yx-yn,zx-zn)||10
    vsRef.current={...vsRef.current,target:[0,0,0],rotationX:30,rotationOrbit:-30,zoom:Math.log2(400/bSize)}
    deckRef.current.setProps({initialViewState:vsRef.current})
    recomputeColors();pushLayer()
  },[data])

  useEffect(()=>{recomputeColors();pushLayer()},[colorMode])
  useEffect(()=>{pushLayer()},[pointSize])

  useEffect(()=>{
    if(!viewPreset||!deckRef.current)return
    const p:Record<string,[number,number]>={persp:[30,-30],top:[90,0],bottom:[-90,0],front:[0,0],back:[0,180],right:[0,-90],left:[0,90]}
    const[rx,ro]=p[viewPreset]||[30,-30]
    vsRef.current={...vsRef.current,target:[0,0,0],rotationX:rx,rotationOrbit:ro}
    deckRef.current.setProps({initialViewState:vsRef.current})
  },[viewPreset])

  useEffect(()=>{deckRef.current?.setProps({controller:interactionMode==='navigate'})},[interactionMode])

  useImperativeHandle(ref,()=>({
    clearHighlight(){highlightRef.current=null;recomputeColors();pushLayer()}
  }),[data,colorMode,pushLayer])

  // ── Selection — uses viewProjectionMatrix directly, no vp.project() per point ──
  const dragRef=useRef({active:false,sx:0,sy:0})
  const rectRef=useRef<HTMLDivElement>(null)

  const onMD=useCallback((e:React.MouseEvent)=>{
    if(interactionMode!=='select'||e.button!==0)return
    const r=containerRef.current!.getBoundingClientRect()
    dragRef.current={active:true,sx:e.clientX-r.left,sy:e.clientY-r.top}
    const rect=rectRef.current!;rect.style.display='block'
    rect.style.left=dragRef.current.sx+'px';rect.style.top=dragRef.current.sy+'px';rect.style.width='0';rect.style.height='0'
  },[interactionMode])

  const onMM=useCallback((e:React.MouseEvent)=>{
    if(!dragRef.current.active)return
    const r=containerRef.current!.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top,rect=rectRef.current!
    rect.style.left=Math.min(dragRef.current.sx,cx)+'px';rect.style.top=Math.min(dragRef.current.sy,cy)+'px'
    rect.style.width=Math.abs(cx-dragRef.current.sx)+'px';rect.style.height=Math.abs(cy-dragRef.current.sy)+'px'
  },[])

  const onMU=useCallback((e:React.MouseEvent)=>{
    if(!dragRef.current.active)return
    dragRef.current.active=false;rectRef.current!.style.display='none'
    if(!data||!deckRef.current)return
    const r=containerRef.current!.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top
    const L=Math.min(dragRef.current.sx,cx),T=Math.min(dragRef.current.sy,cy)
    const R=Math.max(dragRef.current.sx,cx),B=Math.max(dragRef.current.sy,cy)
    if(R-L<5||B-T<5)return

    const vps=deckRef.current.getViewports();if(!vps?.length)return
    const vp=vps[0] as any
    const m:number[]=Array.from(vp.viewProjectionMatrix)
    const el=containerRef.current!, vpW=el.clientWidth, vpH=el.clientHeight

    // Clear previous highlight, mark new using matrix directly (no vp.project per point)
    const pos=data.positions, n=data.count
    const hl=new Uint8Array(n)
    let found=0

    for(let i=0;i<n;i++){
      const px=pos[i*3],py=pos[i*3+1],pz=pos[i*3+2]
      const cw=m[3]*px+m[7]*py+m[11]*pz+m[15]
      if(cw<=0)continue
      const sx=((m[0]*px+m[4]*py+m[8]*pz+m[12])/cw*.5+.5)*vpW
      const sy=(.5-(m[1]*px+m[5]*py+m[9]*pz+m[13])/cw*.5)*vpH
      if(sx>=L&&sx<=R&&sy>=T&&sy<=B){hl[i]=1;found++}
    }
    if(!found)return

    // Apply highlight: recompute base colors then overlay
    highlightRef.current=hl
    recomputeColors()
    pushLayer()

    onSelect({matrix:m,rect:[L,T,R,B],vpWidth:vpW,vpHeight:vpH},found)
  },[data,colorMode,onSelect,pushLayer])

  return(
    <div className="viewport" ref={containerRef} onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU}>
      {interactionMode==='select'&&<div className="sel-overlay"/>}
      <div ref={rectRef} className="sel-rect"/>
    </div>
  )
})
