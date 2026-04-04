import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import type { EdlParams } from './edl-pass'
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

// ---------------------------------------------------------------------------
// RenderPipeline — multi-pass rendering with EDL post-processing
// ---------------------------------------------------------------------------

export class RenderPipeline {
  private sceneTarget: WebGLRenderTarget
  private edlTarget: WebGLRenderTarget
  private readonly edlPass: EdlPass

  // Composite pass (final output with gamma)
  private readonly compositeScene = new ThreeScene()
  private readonly compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly compositeMaterial: RawShaderMaterial
  private readonly compositeQuad: Mesh

  private width: number
  private height: number
  private _edlEnabled = true

  constructor(width: number, height: number) {
    this.width = width
    this.height = height

    // Pass 1 target: scene render with depth
    this.sceneTarget = this.createSceneTarget(width, height)

    // Pass 2 target: EDL output (no depth needed)
    this.edlTarget = new WebGLRenderTarget(width, height)

    // EDL post-processing pass
    this.edlPass = new EdlPass()

    // Pass 3: composite to screen
    this.compositeMaterial = new RawShaderMaterial({
      vertexShader: fullscreenVertShader,
      fragmentShader: compositeFragShader,
      uniforms: {
        uInputTexture: { value: null },
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

  /** Render the full pipeline */
  render(webglRenderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (!this._edlEnabled) {
      // Bypass: render directly to screen
      webglRenderer.setRenderTarget(null)
      webglRenderer.render(scene, camera)
      return
    }

    // Pass 1: Render scene to FBO with depth
    webglRenderer.setRenderTarget(this.sceneTarget)
    webglRenderer.clear()
    webglRenderer.render(scene, camera)

    // Pass 2: EDL post-processing
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

    // Pass 3: Composite to screen with gamma
    this.compositeMaterial.uniforms.uInputTexture!.value = this.edlTarget.texture
    webglRenderer.setRenderTarget(null)
    webglRenderer.clear()
    webglRenderer.render(this.compositeScene, this.compositeCamera)
  }

  /** Update EDL parameters */
  updateEdlParams(params: Partial<EdlParams>): void {
    this.edlPass.updateParams(params)
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
  }

  dispose(): void {
    this.sceneTarget.dispose()
    this.edlTarget.dispose()
    this.edlPass.dispose()
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
