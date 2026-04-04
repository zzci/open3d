/**
 * deck.gl based point cloud viewer.
 *
 * Replaces Three.js pipeline with deck.gl PointCloudLayer.
 * No custom shaders, no FBO management, no GLSL version issues.
 */

import { Deck, OrbitView } from '@deck.gl/core'
import { LineLayer, PointCloudLayer } from '@deck.gl/layers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PointCloudData {
  positions: Float32Array // xyz, length = count * 3
  colors: Uint8Array // rgb 0-255, length = count * 3
  intensity: Uint8Array // 0-255, length = count
  count: number
  bounds: { xn: number, xx: number, yn: number, yx: number, zn: number, zx: number }
  avgSpacing: number
  isGrayscale: boolean
}

export interface ViewerConfig {
  pointSizeMultiplier: number
  colorMode: string
  onViewStateChange?: (vs: DeckViewState) => void
}

export interface DeckViewState {
  target: [number, number, number]
  rotationX: number
  rotationOrbit: number
  zoom: number
  minZoom: number
  maxZoom: number
}

export interface SelectionInfo {
  matrix: number[]
  rect: [number, number, number, number]
  vpWidth: number
  vpHeight: number
}

// ---------------------------------------------------------------------------
// Auto-contrast for intensity display
// ---------------------------------------------------------------------------

function autoContrast(vals: Uint8Array, n: number): [number, number] {
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[vals[i]!]++
  let cum = 0
  let lo = 0
  let hi = 255
  const lo2 = n * 0.02
  for (let i = 0; i < 256; i++) {
    cum += hist[i]!
    if (cum >= lo2) {
      lo = i
      break
    }
  }
  cum = 0
  for (let i = 255; i >= 0; i--) {
    cum += hist[i]!
    if (cum >= n * 0.02) {
      hi = i
      break
    }
  }
  return [lo, Math.max(lo + 1, hi)]
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (!s)
    return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0)
      t++
    if (t > 1)
      t--
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

// ---------------------------------------------------------------------------
// Color computation — writes into pre-allocated buffer
// ---------------------------------------------------------------------------

export function computeColors(data: PointCloudData, mode: string, out: Uint8Array): void {
  const { positions: pos, colors: rgb, intensity: int, count: n, isGrayscale } = data

  if (mode === 'rgb' && !isGrayscale) {
    out.set(rgb.subarray(0, n * 3))
    return
  }

  if (mode === 'rgb' || mode === 'intensity') {
    const [lo, hi] = autoContrast(int, n)
    const r = hi - lo
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (int[i]! - lo) / r))
      const v = (30 + (t ** 0.7) * 225) | 0
      out[i * 3] = v
      out[i * 3 + 1] = v
      out[i * 3 + 2] = v
    }
    return
  }

  if (mode === 'height') {
    let zMin = 1e30
    let zMax = -1e30
    for (let i = 0; i < n; i++) {
      const z = pos[i * 3 + 2]!
      if (z < zMin)
        zMin = z
      if (z > zMax)
        zMax = z
    }
    const r = zMax - zMin || 1
    for (let i = 0; i < n; i++) {
      const t = (pos[i * 3 + 2]! - zMin) / r
      out[i * 3] = (Math.min(1, Math.max(0, 1.5 - Math.abs(t - 0.75) * 4)) * 255) | 0
      out[i * 3 + 1] = (Math.min(1, Math.max(0, 1.5 - Math.abs(t - 0.5) * 4)) * 255) | 0
      out[i * 3 + 2] = (Math.min(1, Math.max(0, 1.5 - Math.abs(t - 0.25) * 4)) * 255) | 0
    }
    return
  }

  if (mode === 'heightIntensity') {
    let zMin = 1e30
    let zMax = -1e30
    for (let i = 0; i < n; i++) {
      const z = pos[i * 3 + 2]!
      if (z < zMin)
        zMin = z
      if (z > zMax)
        zMax = z
    }
    const zR = zMax - zMin || 1
    const [iLo, iHi] = autoContrast(int, n)
    const iR = iHi - iLo
    const lutR = new Uint8Array(256)
    const lutG = new Uint8Array(256)
    const lutB = new Uint8Array(256)
    for (let h = 0; h < 256; h++) {
      const [cr, cg, cb] = hsl2rgb(h / 255 * 0.7, 0.85, 0.55)
      lutR[h] = (cr * 255) | 0
      lutG[h] = (cg * 255) | 0
      lutB[h] = (cb * 255) | 0
    }
    for (let i = 0; i < n; i++) {
      const hIdx = Math.min(255, Math.max(0, ((pos[i * 3 + 2]! - zMin) / zR * 255) | 0))
      const bright = 0.4 + 0.6 * Math.min(1, Math.max(0, (int[i]! - iLo) / iR))
      out[i * 3] = (lutR[hIdx]! * bright) | 0
      out[i * 3 + 1] = (lutG[hIdx]! * bright) | 0
      out[i * 3 + 2] = (lutB[hIdx]! * bright) | 0
    }
    return
  }

  // white fallback
  for (let i = 0; i < n * 3; i++) out[i] = 255
}

// ---------------------------------------------------------------------------
// Grid + axis lines
// ---------------------------------------------------------------------------

interface GridLine {
  s: number[]
  t: number[]
  c: number[]
}

function buildGrid(bounds: PointCloudData['bounds']): { lines: GridLine[], axes: GridLine[] } {
  const { xn, xx, yn, yx, zn } = bounds
  const lines: GridLine[] = []
  const rangeX = xx - xn
  const rangeY = yx - yn
  const maxRange = Math.max(rangeX, rangeY) || 10
  const rawStep = maxRange / 15
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const steps = [1, 2, 5, 10]
  let gridStep = mag
  for (const s of steps) {
    if (mag * s >= rawStep) {
      gridStep = mag * s
      break
    }
  }

  const gxn = Math.floor(xn / gridStep) * gridStep
  const gxx = Math.ceil(xx / gridStep) * gridStep
  const gyn = Math.floor(yn / gridStep) * gridStep
  const gyx = Math.ceil(yx / gridStep) * gridStep
  const gridColor = [180, 182, 185]

  for (let x = gxn; x <= gxx; x += gridStep) {
    const isOrigin = Math.abs(x) < gridStep * 0.01
    lines.push({ s: [x, gyn, zn], t: [x, gyx, zn], c: isOrigin ? [180, 80, 80] : gridColor })
  }
  for (let y = gyn; y <= gyx; y += gridStep) {
    const isOrigin = Math.abs(y) < gridStep * 0.01
    lines.push({ s: [gxn, y, zn], t: [gxx, y, zn], c: isOrigin ? [80, 160, 80] : gridColor })
  }

  const axLen = maxRange * 0.15
  const axes = [
    { s: [0, 0, zn], t: [axLen, 0, zn], c: [220, 60, 60] },
    { s: [0, 0, zn], t: [0, axLen, zn], c: [60, 200, 60] },
    { s: [0, 0, zn], t: [0, 0, zn + axLen], c: [60, 100, 220] },
  ]

  return { lines, axes }
}

// ---------------------------------------------------------------------------
// DeckViewer class
// ---------------------------------------------------------------------------

export class DeckViewer {
  private deck: Deck<any>
  private data: PointCloudData | null = null
  private colorBuf: Uint8Array | null = null
  private highlightBuf: Uint8Array | null = null
  private viewState: DeckViewState
  private config: ViewerConfig
  private container: HTMLElement

  constructor(container: HTMLElement, config: Partial<ViewerConfig> = {}) {
    this.container = container
    this.config = {
      pointSizeMultiplier: 1.0,
      colorMode: 'intensity',
      ...config,
    }

    this.viewState = {
      target: [0, 0, 0],
      rotationX: 30,
      rotationOrbit: -30,
      zoom: 1,
      minZoom: -10,
      maxZoom: 20,
    }

    this.deck = new Deck({
      parent: container as any,
      views: new OrbitView({ orbitAxis: 'Z' }),
      initialViewState: this.viewState,
      controller: { scrollZoom: { speed: 0.1, smooth: true }, touchZoom: true, doubleClickZoom: true, keyboard: true, inertia: 200 } as any,
      parameters: { depthTest: true, clearColor: [0.86, 0.87, 0.88, 1] } as any,
      onViewStateChange: ({ viewState }: any) => {
        this.viewState = viewState
        this.config.onViewStateChange?.(viewState)
        return viewState
      },
      layers: [],
      style: { position: 'absolute', inset: '0' },
    })
  }

  setData(data: PointCloudData): void {
    this.data = data
    this.colorBuf = new Uint8Array(data.count * 3)
    this.highlightBuf = null

    const { xn, xx, yn, yx, zn, zx } = data.bounds
    const bSize = Math.max(xx - xn, yx - yn, zx - zn) || 10

    this.viewState = {
      ...this.viewState,
      target: [0, 0, 0],
      rotationX: 30,
      rotationOrbit: -30,
      zoom: Math.log2(400 / bSize),
    }
    this.deck.setProps({ initialViewState: this.viewState as any })
    this.recomputeColors()
    this.updateLayers()
  }

  setColorMode(mode: string): void {
    this.config.colorMode = mode
    this.recomputeColors()
    this.updateLayers()
  }

  setPointSize(multiplier: number): void {
    this.config.pointSizeMultiplier = multiplier
    this.updateLayers()
  }

  setController(enabled: boolean): void {
    this.deck.setProps({
      controller: enabled
        ? { scrollZoom: { speed: 0.1, smooth: true }, touchZoom: true, doubleClickZoom: true, keyboard: true, inertia: 200 }
        : false,
    })
  }

  setViewPreset(preset: string): void {
    const presets: Record<string, [number, number]> = {
      persp: [30, -30],
      top: [90, 0],
      bottom: [-90, 0],
      front: [0, 0],
      back: [0, 180],
      right: [0, -90],
      left: [0, 90],
    }
    const [rx, ro] = presets[preset] ?? [30, -30]
    this.viewState = { ...this.viewState, target: [0, 0, 0], rotationX: rx, rotationOrbit: ro }
    this.deck.setProps({ initialViewState: this.viewState as any })
  }

  /** Apply highlight overlay — selected points shown in orange */
  setHighlight(highlight: Uint8Array | null): void {
    this.highlightBuf = highlight
    this.recomputeColors()
    this.updateLayers()
  }

  /** Get the current viewProjectionMatrix for selection math */
  getViewProjectionMatrix(): number[] | null {
    const vps = this.deck.getViewports()
    if (!vps?.length)
      return null
    return Array.from((vps[0] as { viewProjectionMatrix: number[] }).viewProjectionMatrix)
  }

  getViewportSize(): { width: number, height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight }
  }

  dispose(): void {
    this.deck.finalize()
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private recomputeColors(): void {
    if (!this.data || !this.colorBuf)
      return
    computeColors(this.data, this.config.colorMode, this.colorBuf)

    // Apply highlight overlay
    if (this.highlightBuf) {
      for (let i = 0; i < this.data.count; i++) {
        if (this.highlightBuf[i]) {
          this.colorBuf[i * 3] = 255
          this.colorBuf[i * 3 + 1] = 100
          this.colorBuf[i * 3 + 2] = 25
        }
      }
    }
  }

  private updateLayers(): void {
    if (!this.data || !this.colorBuf) {
      this.deck.setProps({ layers: [] })
      return
    }

    const { lines, axes } = buildGrid(this.data.bounds)
    const normals = new Float32Array(this.data.count * 3) // flat normals (0,0,0) — no lighting

    this.deck.setProps({
      layers: [
        new LineLayer({
          id: 'grid',
          data: lines,
          getSourcePosition: ((d: GridLine) => d.s) as any,
          getTargetPosition: ((d: GridLine) => d.t) as any,
          getColor: ((d: GridLine) => d.c) as any,
          getWidth: 1,
          widthUnits: 'pixels' as const,
        }),
        new LineLayer({
          id: 'axes',
          data: axes,
          getSourcePosition: ((d: GridLine) => d.s) as any,
          getTargetPosition: ((d: GridLine) => d.t) as any,
          getColor: ((d: GridLine) => d.c) as any,
          getWidth: 3,
          widthUnits: 'pixels' as const,
        }),
        new PointCloudLayer({
          id: 'points',
          data: {
            length: this.data.count,
            attributes: {
              getPosition: { value: this.data.positions, size: 3 },
              getColor: { value: this.colorBuf, size: 3 },
              getNormal: { value: normals, size: 3 },
            },
          },
          pointSize: this.data.avgSpacing * this.config.pointSizeMultiplier * 0.3,
          sizeUnits: 'meters' as const,
          material: false,
        }),
      ],
    })
  }
}
