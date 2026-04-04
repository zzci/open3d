import type { TileData } from '../data/types'
import type { IntensityNormMode } from '../store'
import type { EdlParams } from './post-processing/edl-pass'
import type { SsaoParams } from './post-processing/ssao-pass'
import type { PaletteId } from './palettes/palette-registry'
import type { BlendMode, PointShape, PointUniforms } from './tile-mesh'
import {
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ColorMode } from './color-modes'
import { RenderPipeline } from './post-processing/render-pipeline'
import { disposePalettes, getPaletteTexture } from './palettes/palette-registry'
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
// Renderer configuration
// ---------------------------------------------------------------------------

export interface RendererConfig {
  sizeMultiplier: number
  colorMode: ColorMode
  intensityNormMode: IntensityNormMode
  pointShape: PointShape
  blendMode: BlendMode
}

const DEFAULT_CONFIG: RendererConfig = {
  sizeMultiplier: 1.0,
  colorMode: ColorMode.RGB,
  intensityNormMode: 'linear',
  pointShape: 'circle',
  blendMode: 'opaque',
}

// ---------------------------------------------------------------------------
// PointCloudRenderer — manages Three.js scene, camera, controls
// ---------------------------------------------------------------------------

export class PointCloudRenderer {
  readonly camera: PerspectiveCamera
  readonly scene: Scene
  readonly controls: OrbitControls

  private readonly webglRenderer: WebGLRenderer
  private readonly pipeline: RenderPipeline
  private readonly tiles = new Map<string, TileMesh>()
  private readonly fpsTracker = new FpsTracker()
  private readonly resizeObserver: ResizeObserver

  private animationFrameId = 0
  private lastFrameTime = 0
  private config: RendererConfig
  private heightMin = 0
  private heightMax = 100
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    config?: Partial<RendererConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // WebGL2 renderer
    this.webglRenderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    })
    this.webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // Post-processing pipeline
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    this.pipeline = new RenderPipeline(w, h)

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

    // Resize handling
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(canvas)
    this.handleResize()

    // Start render loop
    this.lastFrameTime = performance.now()
    this.loop()
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

  updatePalette(paletteId: PaletteId): void {
    for (const tile of this.tiles.values()) {
      tile.setPaletteTexture(getPaletteTexture(paletteId))
    }
  }

  // -----------------------------------------------------------------------
  // Post-processing controls
  // -----------------------------------------------------------------------

  setEdlEnabled(enabled: boolean): void {
    this.pipeline.edlEnabled = enabled
  }

  updateEdlParams(params: Partial<EdlParams>): void {
    this.pipeline.updateEdlParams(params)
  }

  setSsaoEnabled(enabled: boolean): void {
    this.pipeline.ssaoEnabled = enabled
  }

  updateSsaoParams(params: Partial<SsaoParams>): void {
    this.pipeline.updateSsaoParams(params)
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

    this.pipeline.dispose()
    disposeSharedResources()
    disposePalettes()
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
    this.fpsTracker.record(now - this.lastFrameTime)
    this.lastFrameTime = now

    this.controls.update()
    this.pipeline.render(this.webglRenderer, this.scene, this.camera)
  }

  private handleResize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (w === 0 || h === 0)
      return

    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.webglRenderer.setSize(w, h, false)
    this.pipeline.setSize(w, h)

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
      screenHeight: this.canvas.clientHeight || 600,
      fov: fovRad,
      colorMode: this.config.colorMode,
      pointShape: this.config.pointShape,
      heightMin: this.heightMin,
      heightMax: this.heightMax,
    }
  }
}
