import type { Texture,
} from 'three'
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Matrix4,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three'
import fullscreenVertShader from './shaders/fullscreen.vert.glsl?raw'
import ssaoBlurFragShader from './shaders/ssao-blur.frag.glsl?raw'
import ssaoFragShader from './shaders/ssao.frag.glsl?raw'

// ---------------------------------------------------------------------------
// SSAO parameters
// ---------------------------------------------------------------------------

export interface SsaoParams {
  radius: number // 0.1-2.0 world units, default 0.5
  intensity: number // 0-1, default 0.5
  samples: 8 | 16 | 32 // kernel size, default 16
}

export const DEFAULT_SSAO_PARAMS: SsaoParams = {
  radius: 0.5,
  intensity: 0.5,
  samples: 16,
}

// ---------------------------------------------------------------------------
// Hemisphere kernel generation
// ---------------------------------------------------------------------------

function generateKernel(size: number): Vector3[] {
  const kernel: Vector3[] = []
  for (let i = 0; i < size; i++) {
    // Random point in hemisphere (z >= 0)
    const x = Math.random() * 2 - 1
    const y = Math.random() * 2 - 1
    const z = Math.random() // hemisphere: z in [0, 1]

    const sample = new Vector3(x, y, z).normalize()

    // Scale to distribute more samples closer to the origin
    let scale = i / size
    scale = lerp(0.1, 1.0, scale * scale)
    sample.multiplyScalar(scale)

    kernel.push(sample)
  }
  return kernel
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ---------------------------------------------------------------------------
// 4x4 noise texture
// ---------------------------------------------------------------------------

function createNoiseTexture(): DataTexture {
  const size = 4
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    // Random rotation vector in tangent plane (z = 0)
    const x = Math.random() * 2 - 1
    const y = Math.random() * 2 - 1
    // Encode [-1,1] -> [0,255]
    data[i * 4] = Math.floor((x * 0.5 + 0.5) * 255)
    data[i * 4 + 1] = Math.floor((y * 0.5 + 0.5) * 255)
    data[i * 4 + 2] = 0
    data[i * 4 + 3] = 255
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.needsUpdate = true
  return texture
}

// ---------------------------------------------------------------------------
// Fullscreen quad
// ---------------------------------------------------------------------------

function createFullscreenQuad(): BufferGeometry {
  const geo = new BufferGeometry()
  const vertices = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0])
  geo.setAttribute('position', new BufferAttribute(vertices, 3))
  return geo
}

// ---------------------------------------------------------------------------
// SsaoPass — screen-space ambient occlusion
// ---------------------------------------------------------------------------

export class SsaoPass {
  // SSAO compute pass
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  // Blur pass
  readonly blurScene = new Scene()
  readonly blurCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

  private readonly material: RawShaderMaterial
  private readonly blurMaterial: RawShaderMaterial
  private readonly quad: Mesh
  private readonly blurQuad: Mesh
  private readonly noiseTexture: DataTexture
  private kernel: Vector3[]

  constructor() {
    this.kernel = generateKernel(32) // always generate max, use subset via uniform
    this.noiseTexture = createNoiseTexture()

    // Flatten kernel to uniform array
    const kernelUniform: { value: Vector3 }[] = []
    for (let i = 0; i < 32; i++) {
      kernelUniform.push({ value: this.kernel[i] ?? new Vector3() })
    }

    this.material = new RawShaderMaterial({
      vertexShader: fullscreenVertShader,
      fragmentShader: ssaoFragShader,
      uniforms: {
        'uDepthTexture': { value: null as Texture | null },
        'uNoiseTexture': { value: this.noiseTexture },
        'uTexelSize': { value: new Vector2() },
        'uNoiseScale': { value: new Vector2() },
        'uRadius': { value: DEFAULT_SSAO_PARAMS.radius },
        'uIntensity': { value: DEFAULT_SSAO_PARAMS.intensity },
        'uBias': { value: 0.025 },
        'uNear': { value: 0.1 },
        'uFar': { value: 10_000 },
        'uProjection': { value: new Matrix4() },
        'uInverseProjection': { value: new Matrix4() },
        'uSampleCount': { value: DEFAULT_SSAO_PARAMS.samples },
        'uKernel[0]': kernelUniform[0],
        'uKernel[1]': kernelUniform[1],
        'uKernel[2]': kernelUniform[2],
        'uKernel[3]': kernelUniform[3],
        'uKernel[4]': kernelUniform[4],
        'uKernel[5]': kernelUniform[5],
        'uKernel[6]': kernelUniform[6],
        'uKernel[7]': kernelUniform[7],
        'uKernel[8]': kernelUniform[8],
        'uKernel[9]': kernelUniform[9],
        'uKernel[10]': kernelUniform[10],
        'uKernel[11]': kernelUniform[11],
        'uKernel[12]': kernelUniform[12],
        'uKernel[13]': kernelUniform[13],
        'uKernel[14]': kernelUniform[14],
        'uKernel[15]': kernelUniform[15],
        'uKernel[16]': kernelUniform[16],
        'uKernel[17]': kernelUniform[17],
        'uKernel[18]': kernelUniform[18],
        'uKernel[19]': kernelUniform[19],
        'uKernel[20]': kernelUniform[20],
        'uKernel[21]': kernelUniform[21],
        'uKernel[22]': kernelUniform[22],
        'uKernel[23]': kernelUniform[23],
        'uKernel[24]': kernelUniform[24],
        'uKernel[25]': kernelUniform[25],
        'uKernel[26]': kernelUniform[26],
        'uKernel[27]': kernelUniform[27],
        'uKernel[28]': kernelUniform[28],
        'uKernel[29]': kernelUniform[29],
        'uKernel[30]': kernelUniform[30],
        'uKernel[31]': kernelUniform[31],
      },
      depthTest: false,
      depthWrite: false,
    })

    this.quad = new Mesh(createFullscreenQuad(), this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    // Blur pass material
    this.blurMaterial = new RawShaderMaterial({
      vertexShader: fullscreenVertShader,
      fragmentShader: ssaoBlurFragShader,
      uniforms: {
        uSsaoTexture: { value: null as Texture | null },
        uTexelSize: { value: new Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    })

    this.blurQuad = new Mesh(createFullscreenQuad(), this.blurMaterial)
    this.blurQuad.frustumCulled = false
    this.blurScene.add(this.blurQuad)
  }

  /** Set depth texture and resolution before rendering */
  setInputs(depthTexture: Texture, width: number, height: number): void {
    const u = this.material.uniforms
    u.uDepthTexture!.value = depthTexture
    u.uTexelSize!.value.set(1.0 / width, 1.0 / height)
    u.uNoiseScale!.value.set(width / 4.0, height / 4.0)

    // Blur pass resolution
    this.blurMaterial.uniforms.uTexelSize!.value.set(1.0 / width, 1.0 / height)
  }

  /** Set the raw SSAO output as blur input */
  setBlurInput(ssaoTexture: Texture): void {
    this.blurMaterial.uniforms.uSsaoTexture!.value = ssaoTexture
  }

  /** Update camera matrices for position reconstruction and projection */
  setCameraMatrices(projection: Matrix4, near: number, far: number): void {
    const u = this.material.uniforms
    u.uProjection!.value.copy(projection)
    u.uInverseProjection!.value.copy(projection).invert()
    u.uNear!.value = near
    u.uFar!.value = far
  }

  /** Update SSAO parameters */
  updateParams(params: Partial<SsaoParams>): void {
    const u = this.material.uniforms
    if (params.radius !== undefined)
      u.uRadius!.value = params.radius
    if (params.intensity !== undefined)
      u.uIntensity!.value = params.intensity
    if (params.samples !== undefined)
      u.uSampleCount!.value = params.samples
  }

  /** Regenerate kernel with new random values */
  regenerateKernel(): void {
    this.kernel = generateKernel(32)
    for (let i = 0; i < 32; i++) {
      this.material.uniforms[`uKernel[${i}]`]!.value = this.kernel[i] ?? new Vector3()
    }
  }

  dispose(): void {
    this.material.dispose()
    this.blurMaterial.dispose()
    this.quad.geometry.dispose()
    this.blurQuad.geometry.dispose()
    this.noiseTexture.dispose()
  }
}
