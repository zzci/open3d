import type { TileData } from '../data/types'
import type { DpiScale, IntensityNormMode } from '../store'
import type { PaletteId } from './palettes/palette-registry'
import type { EdlParams } from './post-processing/edl-pass'
import type { RenderMode } from './render-modes'
import type { BlendMode, PointShape, PointUniforms } from './tile-mesh'
import {
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ColorMode } from './color-modes'
import { disposePalettes, getPaletteTexture } from './palettes/palette-registry'
import { RenderPipeline } from './post-processing/render-pipeline'
import { disposeSharedResources, TileMesh } from './tile-mesh'

// ---------------------------------------------------------------------------
// FPS tracker — simple ring buffer
// ---------------------------------------------------------------------------

class FpsTracker {
  private readonly samples: Float64Array
  private index = 0
  private count = 0

  constructor(private readonly windowSize = 60) {
    this.samples = new Float64Array(windowSize)
  }

  record(deltaMs: number): void {
    this.samples[this.index] = deltaMs
    this.index = (this.index + 1) % this.windowSize
    if (this.count < this.windowSize)
      this.count++
  }

  get fps(): number {
    if (this.count === 0)
      return 0
    let sum = 0
    for (let i = 0; i < this.count; i++) sum += this.samples[i]!
    return 1000 / (sum / this.count)
  }
}

// ---------------------------------------------------------------------------
// Auto-downscale: tracks consecutive low-FPS frames
// ---------------------------------------------------------------------------

const LOW_FPS_THRESHOLD = 20
const LOW_FPS_DURATION_MS = 3000

// ---------------------------------------------------------------------------
// Renderer configuration
// ---------------------------------------------------------------------------

export interface RendererConfig {
  sizeMultiplier: number
  colorMode: ColorMode
  intensityNormMode: IntensityNormMode
  pointShape: PointShape
  blendMode: BlendMode
  dpiScale: DpiScale
}

const DEFAULT_CONFIG: RendererConfig = {
  sizeMultiplier: 1.0,
  colorMode: ColorMode.RGB,
  intensityNormMode: 'linear',
  pointShape: 'circle',
  blendMode: 'opaque',
  dpiScale: 'auto',
}

// ---------------------------------------------------------------------------
// PointCloudRenderer — manages Three.js scene, camera, controls
// ---------------------------------------------------------------------------

export class PointCloudRenderer {
  readonly camera: PerspectiveCamera
  readonly scene: Scene
  readonly controls: OrbitControls

  private readonly webglRenderer: WebGLRenderer
  private readonly tiles = new Map<string, TileMesh>()
  private readonly fpsTracker = new FpsTracker()
  private readonly resizeObserver: ResizeObserver
  private readonly renderPipeline: RenderPipeline

  private animationFrameId = 0
  private lastFrameTime = 0
  private config: RendererConfig
  private heightMin = 0
  private heightMax = 100
  private disposed = false

  // Auto-downscale state
  private lowFpsStart = 0
  private autoDownscaled = false
  private onAutoDownscale: (() => void) | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    config?: Partial<RendererConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // WebGL2 renderer — antialias disabled (handled by MSAA in pipeline)
    this.webglRenderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    })
    this.applyDpiScale(this.config.dpiScale)

    // Scene
    this.scene = new Scene()

    // Camera
    const aspect = canvas.clientWidth / canvas.clientHeight
    this.camera = new PerspectiveCamera(60, aspect, 0.1, 10_000)
    this.camera.position.set(0, 50, 100)

    // Controls
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1

    // Render pipeline (EDL + MSAA)
    const pixelWidth = Math.floor(canvas.clientWidth * this.resolvedDpiScale)
    const pixelHeight = Math.floor(canvas.clientHeight * this.resolvedDpiScale)
    this.renderPipeline = new RenderPipeline(
      Math.max(pixelWidth, 1),
      Math.max(pixelHeight, 1),
      { msaaSamples: 4 },
    )

    // Resize handling
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(canvas)
    this.handleResize()

    // Start render loop
    this.lastFrameTime = performance.now()
    this.loop()
  }

  // -----------------------------------------------------------------------
  // DPI scale
  // -----------------------------------------------------------------------

  /** Resolve 'auto' to an actual numeric DPI scale */
  get resolvedDpiScale(): number {
    if (this.config.dpiScale === 'auto') {
      return Math.min(window.devicePixelRatio, 2)
    }
    return this.config.dpiScale
  }

  /** Update DPI scale at runtime */
  updateDpiScale(scale: DpiScale): void {
    if (this.config.dpiScale === scale)
      return
    this.config = { ...this.config, dpiScale: scale }
    this.autoDownscaled = false
    this.lowFpsStart = 0
    this.applyDpiScale(scale)
    this.handleResize()
  }

  /** Register callback for auto-downscale events */
  setAutoDownscaleCallback(cb: (() => void) | null): void {
    this.onAutoDownscale = cb
  }

  private applyDpiScale(scale: DpiScale): void {
    const resolved = scale === 'auto'
      ? Math.min(window.devicePixelRatio, 2)
      : scale
    this.webglRenderer.setPixelRatio(resolved)
  }

  // -----------------------------------------------------------------------
  // EDL pipeline controls
  // -----------------------------------------------------------------------

  updateEdlEnabled(enabled: boolean): void {
    this.renderPipeline.edlEnabled = enabled
  }

  updateEdlParams(params: Partial<EdlParams>): void {
    this.renderPipeline.updateEdlParams(params)
  }

  // -----------------------------------------------------------------------
  // Tile management (called from scheduler callbacks)
  // -----------------------------------------------------------------------

  addTile(nodeId: string, data: TileData): void {
    if (this.disposed)
      return

    // Remove existing tile with same id if present
    this.removeTile(nodeId)

    const tileMesh = new TileMesh(data, this.buildUniforms(data), this.config.intensityNormMode)
    if (this.config.blendMode !== 'opaque') {
      tileMesh.applyBlendMode(this.config.blendMode)
    }
    this.tiles.set(nodeId, tileMesh)
    this.scene.add(tileMesh.points)
  }

  removeTile(nodeId: string): void {
    const existing = this.tiles.get(nodeId)
    if (existing) {
      this.scene.remove(existing.points)
      existing.dispose()
      this.tiles.delete(nodeId)
    }
  }

  // -----------------------------------------------------------------------
  // Color mode & point size — uniform-only changes, no CPU rebuild
  // -----------------------------------------------------------------------

  updateColorMode(mode: ColorMode): void {
    this.config = { ...this.config, colorMode: mode }
    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ colorMode: mode })
    }
  }

  updateIntensityNormMode(mode: IntensityNormMode): void {
    this.config = { ...this.config, intensityNormMode: mode }
    for (const tile of this.tiles.values()) {
      tile.setIntensityNormMode(mode)
    }
  }

  updateSizeMultiplier(multiplier: number): void {
    this.config = { ...this.config, sizeMultiplier: multiplier }
    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ sizeMultiplier: multiplier })
    }
  }

  updateHeightRange(min: number, max: number): void {
    this.heightMin = min
    this.heightMax = max
    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ heightMin: min, heightMax: max })
    }
  }

  /** Apply per-tile selection masks and toggle selection highlight */
  updateSelection(selectionMap: Map<string, Uint8Array>): void {
    const active = selectionMap.size > 0 ? 1 : 0
    for (const [nodeId, tile] of this.tiles) {
      const mask = selectionMap.get(nodeId) ?? null
      tile.updateSelectionMask(mask)
      tile.updateUniforms({ selectionActive: active })
    }
  }

  updatePointShape(shape: PointShape): void {
    this.config = { ...this.config, pointShape: shape }
    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ pointShape: shape })
    }
  }

  updateBlendMode(mode: BlendMode): void {
    this.config = { ...this.config, blendMode: mode }
    for (const tile of this.tiles.values()) {
      tile.applyBlendMode(mode)
    }
  }

  applyRenderMode(mode: RenderMode): void {
    this.updatePointShape(mode.pointShape)
    this.updateBlendMode(mode.blendMode)
    this.updateEdlEnabled(mode.edlEnabled)
    this.renderPipeline.ssaoEnabled = mode.ssaoEnabled

    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ renderModeSizing: mode.sizingMultiplier })
    }
  }

  updatePalette(paletteId: PaletteId): void {
    for (const tile of this.tiles.values()) {
      tile.setPaletteTexture(getPaletteTexture(paletteId))
    }
  }

  /** Expose tiles map for coarse AABB filtering in selection pipeline */
  getTiles(): ReadonlyMap<string, TileMesh> {
    return this.tiles
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  get fps(): number {
    return this.fpsTracker.fps
  }

  get tileCount(): number {
    return this.tiles.size
  }

  get isAutoDownscaled(): boolean {
    return this.autoDownscaled
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true

    cancelAnimationFrame(this.animationFrameId)
    this.resizeObserver.disconnect()
    this.controls.dispose()

    for (const [id, tile] of this.tiles) {
      this.scene.remove(tile.points)
      tile.dispose()
      this.tiles.delete(id)
    }

    disposeSharedResources()
    disposePalettes()
    this.renderPipeline.dispose()
    this.webglRenderer.dispose()
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed)
      return
    this.animationFrameId = requestAnimationFrame(this.loop)

    const now = performance.now()
    const delta = now - this.lastFrameTime
    this.fpsTracker.record(delta)
    this.lastFrameTime = now

    this.controls.update()

    // Render through EDL + MSAA pipeline
    this.renderPipeline.render(this.webglRenderer, this.scene, this.camera)

    // Auto-downscale: if FPS stays below threshold for 3+ seconds at high DPI
    this.checkAutoDownscale(now)
  }

  private checkAutoDownscale(now: number): void {
    // Only auto-downscale if DPI > 1 and not already downscaled
    if (this.autoDownscaled || this.resolvedDpiScale <= 1)
      return

    const currentFps = this.fpsTracker.fps
    if (currentFps > 0 && currentFps < LOW_FPS_THRESHOLD) {
      if (this.lowFpsStart === 0) {
        this.lowFpsStart = now
      }
      else if (now - this.lowFpsStart >= LOW_FPS_DURATION_MS) {
        // Downscale to 1x
        this.config = { ...this.config, dpiScale: 1 }
        this.applyDpiScale(1)
        this.handleResize()
        this.autoDownscaled = true
        this.lowFpsStart = 0
        this.onAutoDownscale?.()
      }
    }
    else {
      this.lowFpsStart = 0
    }
  }

  private handleResize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (w === 0 || h === 0)
      return

    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.webglRenderer.setSize(w, h, false)

    // Update pipeline FBOs at actual pixel dimensions
    const dpi = this.resolvedDpiScale
    const pixelW = Math.max(Math.floor(w * dpi), 1)
    const pixelH = Math.max(Math.floor(h * dpi), 1)
    this.renderPipeline.setSize(pixelW, pixelH)

    // Broadcast updated screen height to all tile shaders
    for (const tile of this.tiles.values()) {
      tile.updateUniforms({ screenHeight: h })
    }
  }

  private buildUniforms(data: TileData): PointUniforms {
    // Update global height range from tile bounds
    const tileMinY = data.bounds.min[1]
    const tileMaxY = data.bounds.max[1]
    if (this.tiles.size === 0) {
      this.heightMin = tileMinY
      this.heightMax = tileMaxY
    }
    else {
      if (tileMinY < this.heightMin)
        this.heightMin = tileMinY
      if (tileMaxY > this.heightMax)
        this.heightMax = tileMaxY
    }

    // FOV in radians for the vertex shader
    const fovRad = (this.camera.fov * Math.PI) / 180

    return {
      nodeSpacing: data.spacing ?? 1.0,
      sizeMultiplier: this.config.sizeMultiplier,
      renderModeSizing: 1.0,
      screenHeight: this.canvas.clientHeight || 600,
      fov: fovRad,
      colorMode: this.config.colorMode,
      pointShape: this.config.pointShape,
      heightMin: this.heightMin,
      heightMax: this.heightMax,
    }
  }
}
