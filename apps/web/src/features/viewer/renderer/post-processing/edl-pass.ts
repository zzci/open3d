import type {
  Texture,
} from 'three'
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  Vector2,
} from 'three'
import fragmentShader from './shaders/edl.frag.glsl?raw'
import vertexShader from './shaders/fullscreen.vert.glsl?raw'

// ---------------------------------------------------------------------------
// EDL parameters
// ---------------------------------------------------------------------------

export interface EdlParams {
  radius: number // 1-5, default 2
  strength: number // 0-1, default 0.5
  exponent: number // 0.5-5, default 1.0
}

export const DEFAULT_EDL_PARAMS: EdlParams = {
  radius: 2,
  strength: 0.5,
  exponent: 1.0,
}

// ---------------------------------------------------------------------------
// Full-screen quad geometry (shared)
// ---------------------------------------------------------------------------

function createFullscreenQuad(): BufferGeometry {
  const geo = new BufferGeometry()
  // Two triangles covering clip space [-1,1]
  const vertices = new Float32Array([
    -1,
    -1,
    3,
    -1, // oversized triangle trick
    -1,
    3,
  ])
  geo.setAttribute('position', new BufferAttribute(vertices, 2))
  return geo
}

// ---------------------------------------------------------------------------
// EdlPass — applies EDL post-processing
// ---------------------------------------------------------------------------

export class EdlPass {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  private readonly material: RawShaderMaterial
  private readonly quad: Mesh

  constructor() {
    this.material = new RawShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColorTexture: { value: null as Texture | null },
        uDepthTexture: { value: null as Texture | null },
        uTexelSize: { value: new Vector2() },
        uEdlRadius: { value: DEFAULT_EDL_PARAMS.radius },
        uEdlStrength: { value: DEFAULT_EDL_PARAMS.strength },
        uEdlExponent: { value: DEFAULT_EDL_PARAMS.exponent },
        uNear: { value: 0.1 },
        uFar: { value: 10_000 },
      },
      depthTest: false,
      depthWrite: false,
    })

    this.quad = new Mesh(createFullscreenQuad(), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
  }

  /** Update input textures and resolution before rendering */
  setInputs(colorTexture: Texture, depthTexture: Texture, width: number, height: number): void {
    const u = this.material.uniforms
    u.uColorTexture!.value = colorTexture
    u.uDepthTexture!.value = depthTexture
    u.uTexelSize!.value.set(1.0 / width, 1.0 / height)
  }

  /** Update camera near/far for depth linearization */
  setCameraBounds(near: number, far: number): void {
    const u = this.material.uniforms
    u.uNear!.value = near
    u.uFar!.value = far
  }

  /** Update EDL parameters */
  updateParams(params: Partial<EdlParams>): void {
    const u = this.material.uniforms
    if (params.radius !== undefined)
      u.uEdlRadius!.value = params.radius
    if (params.strength !== undefined)
      u.uEdlStrength!.value = params.strength
    if (params.exponent !== undefined)
      u.uEdlExponent!.value = params.exponent
  }

  dispose(): void {
    this.material.dispose()
    this.quad.geometry.dispose()
  }
}
