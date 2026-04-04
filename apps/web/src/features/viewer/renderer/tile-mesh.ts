import type { TileData } from '../data/types'
import type { IntensityNormMode } from '../store'
import type { ColorMode } from './color-modes'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DataTexture,
  FloatType,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  RGBAFormat,
  ShaderMaterial,
} from 'three'
import { buildClassificationPalette } from './color-modes'
import fragmentShader from './shaders/point.frag.glsl?raw'
import vertexShader from './shaders/point.vert.glsl?raw'

// ---------------------------------------------------------------------------
// Shared classification palette texture (singleton — one GPU upload for all tiles)
// ---------------------------------------------------------------------------

let sharedPaletteTexture: DataTexture | null = null

function getClassificationPalette(): DataTexture {
  if (sharedPaletteTexture === null) {
    const data = buildClassificationPalette()
    sharedPaletteTexture = new DataTexture(data, 256, 1, RGBAFormat, FloatType)
    sharedPaletteTexture.needsUpdate = true
  }
  return sharedPaletteTexture
}

// ---------------------------------------------------------------------------
// Point shape & blend mode
// ---------------------------------------------------------------------------

export type PointShape = 'circle' | 'gaussian'
export type BlendMode = 'opaque' | 'alpha' | 'additive'

const POINT_SHAPE_VALUE: Record<PointShape, number> = { circle: 0, gaussian: 1 }

// ---------------------------------------------------------------------------
// Uniforms shared across all tile materials
// ---------------------------------------------------------------------------

export interface PointUniforms {
  nodeSpacing: number
  sizeMultiplier: number
  screenHeight: number
  fov: number
  colorMode: ColorMode
  heightMin: number
  heightMax: number
  selectionActive?: number
  pointShape?: PointShape
}

// ---------------------------------------------------------------------------
// TileMesh — creates and manages a THREE.Points per tile
// ---------------------------------------------------------------------------

export class TileMesh {
  readonly points: Points
  private readonly geometry: BufferGeometry
  private readonly material: ShaderMaterial
  private readonly intensityLinear: Float32Array
  private readonly intensityEqualized: Float32Array

  constructor(data: TileData, uniforms: PointUniforms, intensityNormMode: IntensityNormMode = 'linear') {
    this.geometry = new BufferGeometry()
    this.material = TileMesh.createMaterial(uniforms)

    // Position attribute (required)
    this.geometry.setAttribute(
      'position',
      new BufferAttribute(data.positions, 3),
    )

    // Color attribute — RGB 0-255 → 0-1 via normalized Uint8
    if (data.colors) {
      const colorAttr = new BufferAttribute(data.colors, 3, true) // normalized
      this.geometry.setAttribute('aColor', colorAttr)
    }
    else {
      // Default white when no RGB data
      const white = new Float32Array(data.pointCount * 3).fill(1.0)
      this.geometry.setAttribute('aColor', new BufferAttribute(white, 3))
    }

    // Intensity attributes — store both linear and equalized for runtime swap
    this.intensityLinear = data.intensity ?? new Float32Array(data.pointCount)
    this.intensityEqualized = data.intensityEqualized ?? this.intensityLinear
    const activeIntensity = intensityNormMode === 'histogram' ? this.intensityEqualized : this.intensityLinear
    this.geometry.setAttribute('aIntensity', new BufferAttribute(activeIntensity, 1))

    // Classification attribute
    if (data.classification) {
      const classFloat = new Float32Array(data.classification)
      this.geometry.setAttribute(
        'aClassification',
        new BufferAttribute(classFloat, 1),
      )
    }
    else {
      const zeros = new Float32Array(data.pointCount)
      this.geometry.setAttribute(
        'aClassification',
        new BufferAttribute(zeros, 1),
      )
    }

    // Return number attribute
    if (data.returnNumber) {
      const rnFloat = new Float32Array(data.returnNumber)
      this.geometry.setAttribute(
        'aReturnNumber',
        new BufferAttribute(rnFloat, 1),
      )
    }
    else {
      const zeros = new Float32Array(data.pointCount)
      this.geometry.setAttribute(
        'aReturnNumber',
        new BufferAttribute(zeros, 1),
      )
    }

    // Selection attribute — default all zeros (not selected)
    const selectionData = new Float32Array(data.pointCount)
    this.geometry.setAttribute(
      'aSelected',
      new BufferAttribute(selectionData, 1),
    )

    this.points = new Points(this.geometry, this.material)
    this.points.frustumCulled = false // scheduler handles culling
  }

  /** Update shared uniforms (called when user changes settings) */
  updateUniforms(uniforms: Partial<PointUniforms>): void {
    const u = this.material.uniforms
    if (uniforms.nodeSpacing !== undefined)
      u.uNodeSpacing!.value = uniforms.nodeSpacing
    if (uniforms.sizeMultiplier !== undefined)
      u.uSizeMultiplier!.value = uniforms.sizeMultiplier
    if (uniforms.screenHeight !== undefined)
      u.uScreenHeight!.value = uniforms.screenHeight
    if (uniforms.fov !== undefined)
      u.uFov!.value = uniforms.fov
    if (uniforms.colorMode !== undefined)
      u.uColorMode!.value = uniforms.colorMode
    if (uniforms.heightMin !== undefined)
      u.uHeightMin!.value = uniforms.heightMin
    if (uniforms.heightMax !== undefined)
      u.uHeightMax!.value = uniforms.heightMax
    if (uniforms.selectionActive !== undefined)
      u.uSelectionActive!.value = uniforms.selectionActive
    if (uniforms.pointShape !== undefined)
      u.uPointShape!.value = POINT_SHAPE_VALUE[uniforms.pointShape]
  }

  /** Apply blend mode to this tile's material */
  applyBlendMode(mode: BlendMode): void {
    const m = this.material
    switch (mode) {
      case 'opaque':
        m.blending = NormalBlending
        m.depthWrite = true
        m.transparent = false
        break
      case 'alpha':
        // Pre-multiplied alpha: src×1 + dst×(1−srcAlpha)
        m.blending = CustomBlending
        m.blendSrc = OneFactor
        m.blendDst = OneMinusSrcAlphaFactor
        m.depthWrite = false
        m.transparent = true
        break
      case 'additive':
        m.blending = AdditiveBlending
        m.depthWrite = false
        m.transparent = true
        break
    }
    m.needsUpdate = true
  }

  /** Swap the color palette texture used for palette-based color modes */
  setPaletteTexture(texture: DataTexture): void {
    this.material.uniforms.uColorPalette!.value = texture
  }

  /** Swap the active intensity buffer between linear and equalized */
  setIntensityNormMode(mode: IntensityNormMode): void {
    const target = mode === 'histogram' ? this.intensityEqualized : this.intensityLinear
    const attr = this.geometry.getAttribute('aIntensity') as BufferAttribute
    if (attr.array !== target) {
      this.geometry.setAttribute('aIntensity', new BufferAttribute(target, 1))
    }
  }

  /** Update per-point selection mask from Uint8Array bitmask */
  updateSelectionMask(mask: Uint8Array | null): void {
    const attr = this.geometry.getAttribute('aSelected') as BufferAttribute
    const arr = attr.array as Float32Array
    if (mask && mask.length === arr.length) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = mask[i]!
      }
    }
    else {
      arr.fill(0)
    }
    attr.needsUpdate = true
  }

  /** Dispose all GPU resources — MUST be called on eviction */
  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    // Note: shared palette texture is NOT disposed per tile
  }

  // -------------------------------------------------------------------------
  // Material factory
  // -------------------------------------------------------------------------

  private static createMaterial(uniforms: PointUniforms): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uNodeSpacing: { value: uniforms.nodeSpacing },
        uSizeMultiplier: { value: uniforms.sizeMultiplier },
        uScreenHeight: { value: uniforms.screenHeight },
        uFov: { value: uniforms.fov },
        uColorMode: { value: uniforms.colorMode },
        uPointShape: { value: POINT_SHAPE_VALUE[uniforms.pointShape ?? 'circle'] },
        uHeightMin: { value: uniforms.heightMin },
        uHeightMax: { value: uniforms.heightMax },
        uSelectionActive: { value: uniforms.selectionActive ?? 0 },
        uClassificationPalette: { value: getClassificationPalette() },
        uColorPalette: { value: getClassificationPalette() },
      },
      depthWrite: true,
      depthTest: true,
      transparent: false,
    })
  }
}

/**
 * Dispose the shared classification palette texture.
 * Call once when the entire renderer is torn down.
 */
export function disposeSharedResources(): void {
  if (sharedPaletteTexture !== null) {
    sharedPaletteTexture.dispose()
    sharedPaletteTexture = null
  }
}
