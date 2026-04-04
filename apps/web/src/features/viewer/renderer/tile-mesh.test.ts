import type { TileData } from '../data/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ColorMode } from './color-modes'

// Mock three.js modules to avoid WebGL dependency
vi.mock('three', () => {
  class MockBufferAttribute {
    array: ArrayLike<number>
    itemSize: number
    constructor(array: ArrayLike<number>, itemSize: number, _normalized?: boolean) {
      this.array = array
      this.itemSize = itemSize
    }
  }

  class MockBufferGeometry {
    attributes: Record<string, MockBufferAttribute> = {}
    setAttribute(name: string, attr: MockBufferAttribute) { this.attributes[name] = attr }
    dispose = vi.fn()
  }

  class MockShaderMaterial {
    uniforms: Record<string, { value: unknown }> = {}
    constructor(params?: Record<string, unknown>) {
      if (params?.uniforms)
        this.uniforms = params.uniforms as Record<string, { value: unknown }>
    }

    dispose = vi.fn()
  }

  class MockPoints {
    geometry: MockBufferGeometry
    material: MockShaderMaterial
    frustumCulled = true
    constructor(geometry: MockBufferGeometry, material: MockShaderMaterial) {
      this.geometry = geometry
      this.material = material
    }
  }

  class MockDataTexture {
    needsUpdate = false
    dispose = vi.fn()
  }

  return {
    BufferAttribute: MockBufferAttribute,
    BufferGeometry: MockBufferGeometry,
    ShaderMaterial: MockShaderMaterial,
    Points: MockPoints,
    DataTexture: MockDataTexture,
    FloatType: 1015,
    RGBAFormat: 1023,
  }
})

vi.mock('./shaders/point.vert.glsl?raw', () => ({ default: 'mock vertex shader' }))
vi.mock('./shaders/point.frag.glsl?raw', () => ({ default: 'mock fragment shader' }))

function makeTileData(overrides?: Partial<TileData>): TileData {
  const pointCount = 100
  return {
    nodeId: '0-0-0-0',
    level: 0,
    pointCount,
    bounds: { min: [0, 0, 0], max: [10, 10, 10] },
    positions: new Float32Array(pointCount * 3),
    colors: new Uint8Array(pointCount * 3).fill(128),
    intensity: new Float32Array(pointCount).fill(0.5),
    classification: new Uint8Array(pointCount).fill(2),
    ...overrides,
  }
}

describe('tileMesh', () => {
  // Reset the shared palette between tests
  beforeEach(async () => {
    vi.resetModules()
  })

  it('creates a Points object with correct geometry attributes', async () => {
    const { TileMesh } = await import('./tile-mesh')
    const data = makeTileData()
    const tile = new TileMesh(data, {
      pointSize: 2.0,
      colorMode: ColorMode.RGB,
      heightMin: 0,
      heightMax: 10,
    })

    expect(tile.points).toBeDefined()
    expect(tile.points.frustumCulled).toBe(false)

    const geom = tile.points.geometry as unknown as { attributes: Record<string, { itemSize: number }> }
    expect(geom.attributes.position?.itemSize).toBe(3)
    expect(geom.attributes.aColor?.itemSize).toBe(3)
    expect(geom.attributes.aIntensity?.itemSize).toBe(1)
    expect(geom.attributes.aClassification?.itemSize).toBe(1)
  })

  it('creates default white color attribute when colors missing', async () => {
    const { TileMesh } = await import('./tile-mesh')
    const data = makeTileData({ colors: undefined })
    const tile = new TileMesh(data, {
      pointSize: 2.0,
      colorMode: ColorMode.RGB,
      heightMin: 0,
      heightMax: 10,
    })

    const geom = tile.points.geometry as unknown as { attributes: Record<string, { array: ArrayLike<number>, itemSize: number }> }
    const colorAttr = geom.attributes.aColor
    expect(colorAttr?.itemSize).toBe(3)
    // All values should be 1.0 (white)
    for (let i = 0; i < data.pointCount * 3; i++) {
      expect(colorAttr!.array[i]).toBe(1.0)
    }
  })

  it('updates uniforms without recreating geometry', async () => {
    const { TileMesh } = await import('./tile-mesh')
    const data = makeTileData()
    const tile = new TileMesh(data, {
      pointSize: 2.0,
      colorMode: ColorMode.RGB,
      heightMin: 0,
      heightMax: 10,
    })

    const mat = tile.points.material as unknown as { uniforms: Record<string, { value: unknown }> }
    expect(mat.uniforms.uColorMode!.value).toBe(ColorMode.RGB)
    expect(mat.uniforms.uPointSize!.value).toBe(2.0)

    tile.updateUniforms({ colorMode: ColorMode.Height, pointSize: 4.0 })

    expect(mat.uniforms.uColorMode!.value).toBe(ColorMode.Height)
    expect(mat.uniforms.uPointSize!.value).toBe(4.0)
  })

  it('disposes geometry and material on dispose()', async () => {
    const { TileMesh } = await import('./tile-mesh')
    const data = makeTileData()
    const tile = new TileMesh(data, {
      pointSize: 2.0,
      colorMode: ColorMode.RGB,
      heightMin: 0,
      heightMax: 10,
    })

    const geom = tile.points.geometry as unknown as { dispose: ReturnType<typeof vi.fn> }
    const mat = tile.points.material as unknown as { dispose: ReturnType<typeof vi.fn> }

    tile.dispose()

    expect(geom.dispose).toHaveBeenCalledOnce()
    expect(mat.dispose).toHaveBeenCalledOnce()
  })
})

describe('disposeSharedResources', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('disposes the shared palette texture', async () => {
    const { TileMesh, disposeSharedResources } = await import('./tile-mesh')
    const data = makeTileData()
    // Creating a tile initializes the shared palette
    const _tile = new TileMesh(data, {
      pointSize: 2.0,
      colorMode: ColorMode.RGB,
      heightMin: 0,
      heightMax: 10,
    })

    // Should not throw
    disposeSharedResources()
    // Second call is safe (no-op)
    disposeSharedResources()
  })
})
