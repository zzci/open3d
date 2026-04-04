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
import { SsaoPass } from './ssao-pass'
import compositeFragShader from './shaders/composite.frag.glsl?raw'
import fullscreenVertShader from './shaders/fullscreen.vert.glsl?raw'

// ---------------------------------------------------------------------------
// RenderPipeline — multi-pass rendering with EDL + SSAO post-processing
// ---------------------------------------------------------------------------

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

  constructor(width: number, height: number) {
    this.width = width
    this.height = height

    // Pass 1 target: scene render with depth
    this.sceneTarget = this.createSceneTarget(width, height)

    // Pass 2 target: EDL output (no depth needed)
    this.edlTarget = new WebGLRenderTarget(width, height)

    // Pass 3 targets: SSAO + blur
    this.ssaoTarget = new WebGLRenderTarget(width, height)
    this.ssaoBlurTarget = new WebGLRenderTarget(width, height)

    // EDL post-processing pass
    this.edlPass = new EdlPass()

    // SSAO post-processing pass
    this.ssaoPass = new SsaoPass()

    // Composite pass: combines color + SSAO
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
    const vertices = new Float32Array([-1, -1, 3, -1, -1, 3])
    geo.setAttribute('position', new BufferAttribute(vertices, 2))
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

  /** Render the full pipeline */
  render(webglRenderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    const noPostProcessing = !this._edlEnabled && !this._ssaoEnabled
    if (noPostProcessing) {
      // Bypass: render directly to screen
      webglRenderer.setRenderTarget(null)
      webglRenderer.render(scene, camera)
      return
    }

    // Pass 1: Render scene to FBO with depth
    webglRenderer.setRenderTarget(this.sceneTarget)
    webglRenderer.clear()
    webglRenderer.render(scene, camera)

    // Pass 2: EDL post-processing (or pass-through color)
    let colorSource = this.sceneTarget.texture
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

    // Pass 3: SSAO (optional)
    if (this._ssaoEnabled) {
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

      // 3a: Compute raw SSAO
      webglRenderer.setRenderTarget(this.ssaoTarget)
      webglRenderer.clear()
      webglRenderer.render(this.ssaoPass.scene, this.ssaoPass.camera)

      // 3b: Blur SSAO
      this.ssaoPass.setBlurInput(this.ssaoTarget.texture)
      webglRenderer.setRenderTarget(this.ssaoBlurTarget)
      webglRenderer.clear()
      webglRenderer.render(this.ssaoPass.blurScene, this.ssaoPass.blurCamera)
    }

    // Pass 4: Composite to screen with gamma + SSAO
    this.compositeMaterial.uniforms.uInputTexture!.value = colorSource
    this.compositeMaterial.uniforms.uSsaoTexture!.value = this.ssaoBlurTarget.texture
    this.compositeMaterial.uniforms.uSsaoEnabled!.value = this._ssaoEnabled ? 1 : 0

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

  /** Handle resize — recreate render targets */
  setSize(width: number, height: number): void {
    if (this.width === width && this.height === height)
      return

    this.width = width
    this.height = height

    this.sceneTarget.dispose()
    this.sceneTarget = this.createSceneTarget(width, height)

    this.edlTarget.dispose()
    this.edlTarget = new WebGLRenderTarget(width, height)

    this.ssaoTarget.dispose()
    this.ssaoTarget = new WebGLRenderTarget(width, height)

    this.ssaoBlurTarget.dispose()
    this.ssaoBlurTarget = new WebGLRenderTarget(width, height)
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

    const target = new WebGLRenderTarget(w, h)
    target.depthTexture = depthTexture
    return target
  }
}
