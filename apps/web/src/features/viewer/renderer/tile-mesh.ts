import type { TileData } from '../data/types'
import type { ColorMode } from './color-modes'
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
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
// Uniforms shared across all tile materials
// ---------------------------------------------------------------------------

export interface PointUniforms {
  pointSize: number
  colorMode: ColorMode
  heightMin: number
  heightMax: number
}

// ---------------------------------------------------------------------------
// TileMesh — creates and manages a THREE.Points per tile
// ---------------------------------------------------------------------------

export class TileMesh {
  readonly points: Points
  private readonly geometry: BufferGeometry
  private readonly material: ShaderMaterial

  constructor(data: TileData, uniforms: PointUniforms) {
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

    // Intensity attribute
    if (data.intensity) {
      this.geometry.setAttribute(
        'aIntensity',
        new BufferAttribute(data.intensity, 1),
      )
    }
    else {
      const zeros = new Float32Array(data.pointCount)
      this.geometry.setAttribute('aIntensity', new BufferAttribute(zeros, 1))
    }

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

    this.points = new Points(this.geometry, this.material)
    this.points.frustumCulled = false // scheduler handles culling
  }

  /** Update shared uniforms (called when user changes settings) */
  updateUniforms(uniforms: Partial<PointUniforms>): void {
    const u = this.material.uniforms
    if (uniforms.pointSize !== undefined)
      u.uPointSize!.value = uniforms.pointSize
    if (uniforms.colorMode !== undefined)
      u.uColorMode!.value = uniforms.colorMode
    if (uniforms.heightMin !== undefined)
      u.uHeightMin!.value = uniforms.heightMin
    if (uniforms.heightMax !== undefined)
      u.uHeightMax!.value = uniforms.heightMax
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
        uPointSize: { value: uniforms.pointSize },
        uColorMode: { value: uniforms.colorMode },
        uHeightMin: { value: uniforms.heightMin },
        uHeightMax: { value: uniforms.heightMax },
        uClassificationPalette: { value: getClassificationPalette() },
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
