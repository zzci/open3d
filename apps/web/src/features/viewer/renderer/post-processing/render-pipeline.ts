import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import type { EdlParams } from './edl-pass'
import type { SsaoParams } from './ssao-pass'
import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  Mesh,
  OrthographicCamera,
  RawShaderMaterial,
  Scene as ThreeScene,
  UnsignedIntType,
  WebGLRenderTarget,
} from 'three'
import { EdlPass } from './edl-pass'
import compositeFragShader from './shaders/composite.frag.glsl?raw'
import fullscreenVertShader from './shaders/fullscreen.vert.glsl?raw'
import { SsaoPass } from './ssao-pass'

// ---------------------------------------------------------------------------
// RenderPipeline — multi-pass rendering with EDL post-processing and MSAA
// ---------------------------------------------------------------------------

export interface RenderPipelineOptions {
  msaaSamples: number
}

export class RenderPipeline {
  private sceneTarget: WebGLRenderTarget
  private edlTarget: WebGLRenderTarget
  private ssaoTarget: WebGLRenderTarget
  private ssaoBlurTarget: WebGLRenderTarget
  private readonly edlPass: EdlPass
  private readonly ssaoPass: SsaoPass

  // Composite pass (final output with gamma)
  private readonly compositeScene = new ThreeScene()
  private readonly compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly compositeMaterial: RawShaderMaterial
  private readonly compositeQuad: Mesh

  private width: number
  private height: number
  private _edlEnabled = true
  private _ssaoEnabled = false
  private _msaaSamples: number
  private _resizing = false

  constructor(width: number, height: number, options?: Partial<RenderPipelineOptions>) {
    this.width = width
    this.height = height
    this._msaaSamples = options?.msaaSamples ?? 4

    // Pass 1 target: scene render with depth (+ MSAA)
    this.sceneTarget = this.createSceneTarget(width, height)

    // Pass 2 target: EDL output (no depth needed, no MSAA)
    this.edlTarget = new WebGLRenderTarget(width, height)

    // SSAO targets
    this.ssaoTarget = new WebGLRenderTarget(width, height)
    this.ssaoBlurTarget = new WebGLRenderTarget(width, height)

    // EDL post-processing pass
    this.edlPass = new EdlPass()

    // SSAO post-processing pass
    this.ssaoPass = new SsaoPass()

    // Composite pass: final output with gamma
    this.compositeMaterial = new RawShaderMaterial({
      vertexShader: fullscreenVertShader,
      fragmentShader: compositeFragShader,
      uniforms: {
        uInputTexture: { value: null },
        uSsaoTexture: { value: null },
        uSsaoEnabled: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })

    const geo = new BufferGeometry()
    const vertices = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0])
    geo.setAttribute('position', new BufferAttribute(vertices, 3))
    this.compositeQuad = new Mesh(geo, this.compositeMaterial)
    this.compositeQuad.frustumCulled = false
    this.compositeScene.add(this.compositeQuad)
  }

  get edlEnabled(): boolean {
    return this._edlEnabled
  }

  set edlEnabled(value: boolean) {
    this._edlEnabled = value
  }

  get ssaoEnabled(): boolean {
    return this._ssaoEnabled
  }

  set ssaoEnabled(value: boolean) {
    this._ssaoEnabled = value
  }

  get msaaSamples(): number {
    return this._msaaSamples
  }

  set msaaSamples(value: number) {
    if (this._msaaSamples === value)
      return
    this._msaaSamples = value
    // Recreate scene target with new MSAA sample count
    this.sceneTarget.dispose()
    this.sceneTarget = this.createSceneTarget(this.width, this.height)
  }

  /** Render the full pipeline */
  render(webglRenderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (this._resizing)
      return

    const needsFbo = this._edlEnabled || this._ssaoEnabled

    if (!needsFbo) {
      // Bypass: render directly to screen
      webglRenderer.setRenderTarget(null)
      webglRenderer.render(scene, camera)
      return
    }

    // Pass 1: Render scene to FBO with depth (+ MSAA)
    webglRenderer.setRenderTarget(this.sceneTarget)
    webglRenderer.clear()
    webglRenderer.render(scene, camera)

    // Determine the color source for the composite pass
    let colorSource = this.sceneTarget.texture

    // Pass 2: EDL post-processing (optional)
    if (this._edlEnabled) {
      this.edlPass.setInputs(
        this.sceneTarget.texture,
        this.sceneTarget.depthTexture!,
        this.width,
        this.height,
      )
      this.edlPass.setCameraBounds(camera.near, camera.far)

      webglRenderer.setRenderTarget(this.edlTarget)
      webglRenderer.clear()
      webglRenderer.render(this.edlPass.scene, this.edlPass.camera)
      colorSource = this.edlTarget.texture
    }

    // SSAO passes (optional)
    if (this._ssaoEnabled) {
      // SSAO compute pass
      this.ssaoPass.setInputs(
        this.sceneTarget.depthTexture!,
        this.width,
        this.height,
      )
      this.ssaoPass.setCameraMatrices(
        camera.projectionMatrix,
        camera.near,
        camera.far,
      )

      webglRenderer.setRenderTarget(this.ssaoTarget)
      webglRenderer.clear()
      webglRenderer.render(this.ssaoPass.scene, this.ssaoPass.camera)

      // SSAO blur pass
      this.ssaoPass.setBlurInput(this.ssaoTarget.texture)
      webglRenderer.setRenderTarget(this.ssaoBlurTarget)
      webglRenderer.clear()
      webglRenderer.render(this.ssaoPass.blurScene, this.ssaoPass.blurCamera)
    }

    // Composite pass: merge color + SSAO + gamma
    this.compositeMaterial.uniforms.uInputTexture!.value = colorSource
    this.compositeMaterial.uniforms.uSsaoEnabled!.value = this._ssaoEnabled ? 1 : 0
    if (this._ssaoEnabled) {
      this.compositeMaterial.uniforms.uSsaoTexture!.value = this.ssaoBlurTarget.texture
    }
    webglRenderer.setRenderTarget(null)
    webglRenderer.clear()
    webglRenderer.render(this.compositeScene, this.compositeCamera)
  }

  /** Update EDL parameters */
  updateEdlParams(params: Partial<EdlParams>): void {
    this.edlPass.updateParams(params)
  }

  /** Update SSAO parameters */
  updateSsaoParams(params: Partial<SsaoParams>): void {
    this.ssaoPass.updateParams(params)
  }

  /** Handle resize — recreate render targets at actual pixel dimensions */
  setSize(width: number, height: number): void {
    if (this.width === width && this.height === height)
      return

    this._resizing = true
    this.width = width
    this.height = height

    // Create new targets before disposing old ones (atomic swap)
    const newScene = this.createSceneTarget(width, height)
    const newEdl = new WebGLRenderTarget(width, height)
    const newSsao = new WebGLRenderTarget(width, height)
    const newSsaoBlur = new WebGLRenderTarget(width, height)

    const oldScene = this.sceneTarget
    const oldEdl = this.edlTarget
    const oldSsao = this.ssaoTarget
    const oldSsaoBlur = this.ssaoBlurTarget

    this.sceneTarget = newScene
    this.edlTarget = newEdl
    this.ssaoTarget = newSsao
    this.ssaoBlurTarget = newSsaoBlur

    oldScene.dispose()
    oldEdl.dispose()
    oldSsao.dispose()
    oldSsaoBlur.dispose()

    this._resizing = false
  }

  dispose(): void {
    this.sceneTarget.dispose()
    this.edlTarget.dispose()
    this.ssaoTarget.dispose()
    this.ssaoBlurTarget.dispose()
    this.edlPass.dispose()
    this.ssaoPass.dispose()
    this.compositeMaterial.dispose()
    this.compositeQuad.geometry.dispose()
  }

  private createSceneTarget(w: number, h: number): WebGLRenderTarget {
    const depthTexture = new DepthTexture(w, h)
    depthTexture.type = UnsignedIntType // DEPTH_COMPONENT24

    // Note: MSAA (samples > 0) and depthTexture are mutually exclusive in Three.js WebGL2.
    // When EDL/SSAO need depth texture, we skip MSAA on the scene target.
    // The point shader's Gaussian alpha falloff provides adequate edge quality.
    const target = new WebGLRenderTarget(w, h)
    target.depthTexture = depthTexture
    return target
  }
}
