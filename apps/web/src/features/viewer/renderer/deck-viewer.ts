/**
 * Three.js point cloud viewer — based on proven aaa/templates/index.html approach.
 *
 * Simple PointsMaterial with vertexColors + sizeAttenuation.
 * No custom shaders, no FBO, no GLSL version issues.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PointCloudData {
  positions: Float32Array
  colors: Uint8Array
  intensity: Uint8Array
  count: number
  bounds: { xn: number, xx: number, yn: number, yx: number, zn: number, zx: number }
  avgSpacing: number
  isGrayscale: boolean
}

// ---------------------------------------------------------------------------
// Auto-contrast for intensity
// ---------------------------------------------------------------------------

function autoContrast(vals: Uint8Array, n: number): [number, number] {
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[vals[i]!]++
  let cum = 0
  let lo = 0
  let hi = 255
  const lo2 = n * 0.02
  for (let i = 0; i < 256; i++) { cum += hist[i]!; if (cum >= lo2) { lo = i; break } }
  cum = 0
  for (let i = 255; i >= 0; i--) { cum += hist[i]!; if (cum >= n * 0.02) { hi = i; break } }
  return [lo, Math.max(lo + 1, hi)]
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t++
    if (t > 1) t--
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)]
}

// ---------------------------------------------------------------------------
// Color computation — writes Float32Array (0-1 range) for Three.js
// ---------------------------------------------------------------------------

export function computeColors(data: PointCloudData, mode: string, out: Float32Array): void {
  const { positions: pos, colors: rgb, intensity: int, count: n, isGrayscale } = data

  if (mode === 'rgb' && !isGrayscale) {
    for (let i = 0; i < n * 3; i++) out[i] = rgb[i]! / 255
    return
  }

  if (mode === 'rgb' || mode === 'intensity') {
    const [lo, hi] = autoContrast(int, n)
    const r = hi - lo || 1
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, Math.max(0, (int[i]! - lo) / r))
      out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v
    }
    return
  }

  if (mode === 'height') {
    let zMin = 1e30, zMax = -1e30
    for (let i = 0; i < n; i++) { const z = pos[i * 3 + 2]!; if (z < zMin) zMin = z; if (z > zMax) zMax = z }
    const r = zMax - zMin || 1
    for (let i = 0; i < n; i++) {
      const t = (pos[i * 3 + 2]! - zMin) / r
      out[i * 3] = Math.min(1, Math.max(0, t * 3 - 1))
      out[i * 3 + 1] = Math.min(1, Math.max(0, t < 0.5 ? t * 2 : 2 - t * 2))
      out[i * 3 + 2] = Math.min(1, Math.max(0, 1 - t * 3))
    }
    return
  }

  if (mode === 'heightIntensity') {
    let zMin = 1e30, zMax = -1e30
    for (let i = 0; i < n; i++) { const z = pos[i * 3 + 2]!; if (z < zMin) zMin = z; if (z > zMax) zMax = z }
    const zR = zMax - zMin || 1
    const [iLo, iHi] = autoContrast(int, n)
    const iR = iHi - iLo
    const lutR = new Float32Array(256), lutG = new Float32Array(256), lutB = new Float32Array(256)
    for (let h = 0; h < 256; h++) {
      const [cr, cg, cb] = hsl2rgb(h / 255 * 0.7, 0.85, 0.55)
      lutR[h] = cr; lutG[h] = cg; lutB[h] = cb
    }
    for (let i = 0; i < n; i++) {
      const hIdx = Math.min(255, Math.max(0, ((pos[i * 3 + 2]! - zMin) / zR * 255) | 0))
      const bright = 0.4 + 0.6 * Math.min(1, Math.max(0, (int[i]! - iLo) / iR))
      out[i * 3] = lutR[hIdx]! * bright; out[i * 3 + 1] = lutG[hIdx]! * bright; out[i * 3 + 2] = lutB[hIdx]! * bright
    }
    return
  }

  if (mode === 'shading') {
    let zMin = 1e30, zMax = -1e30
    for (let i = 0; i < n; i++) { const z = pos[i * 3 + 2]!; if (z < zMin) zMin = z; if (z > zMax) zMax = z }
    const zR = zMax - zMin || 1
    for (let i = 0; i < n; i++) {
      const zN = Math.min(1, Math.max(0, (pos[i * 3 + 2]! - zMin) / zR))
      const cr = Math.min(1, Math.max(0, zN * 2)) * 0.6 + 0.3
      const cg = Math.min(1, Math.max(0, 1 - Math.abs(zN - 0.5) * 2)) * 0.5 + 0.3
      const cb = Math.min(1, Math.max(0, (1 - zN) * 2)) * 0.6 + 0.3
      const bright = 0.4 + 0.6 * Math.min(1, Math.max(0, int[i]! / 255))
      out[i * 3] = cr * bright; out[i * 3 + 1] = cg * bright; out[i * 3 + 2] = cb * bright
    }
    return
  }

  if (mode === 'edl') {
    const [iLo, iHi] = autoContrast(int, n)
    const iR = iHi - iLo
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, (int[i]! - iLo) / iR))
      out[i * 3] = 0.3 + t * 0.7; out[i * 3 + 1] = 0.3 + t * 0.65; out[i * 3 + 2] = 0.4 + (1 - t) * 0.2 + t * 0.4
    }
    return
  }

  // white
  for (let i = 0; i < n * 3; i++) out[i] = 1
}

// ---------------------------------------------------------------------------
// ThreeViewer class — based on aaa/templates/index.html
// ---------------------------------------------------------------------------

export class DeckViewer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private pointsMesh: THREE.Points | null = null
  private colArr: Float32Array | null = null
  private origColArr: Float32Array | null = null
  private highlightBuf: Uint8Array | null = null
  private data: PointCloudData | null = null
  private boundRadius = 50
  private animId = 0
  private container: HTMLElement
  private colorMode = 'intensity'
  private pointSizeMultiplier = 1.0

  constructor(container: HTMLElement, config: { colorMode?: string, pointSizeMultiplier?: number } = {}) {
    this.container = container
    this.colorMode = config.colorMode ?? 'intensity'
    this.pointSizeMultiplier = config.pointSizeMultiplier ?? 1.0

    // Scene
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x808085)

    // Camera
    const w = container.clientWidth || window.innerWidth
    const h = container.clientHeight || window.innerHeight
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 5000)
    this.camera.position.set(20, 15, 20)

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(w, h)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    // Controls — match aaa/ settings
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.1
    this.controls.rotateSpeed = 0.8
    this.controls.zoomSpeed = 1.2
    this.controls.panSpeed = 0.8
    this.controls.screenSpacePanning = true
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

    // Grid + Axes
    this.scene.add(new THREE.GridHelper(200, 40, 0x444444, 0x333333))
    this.scene.add(new THREE.AxesHelper(5))

    // Resize
    window.addEventListener('resize', this.onResize)

    // Render loop
    this.animate()
  }

  setData(data: PointCloudData): void {
    this.data = data
    this.highlightBuf = null
    this.origColArr = null

    // Build geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))

    // Colors (Float32, 0-1 range)
    this.colArr = new Float32Array(data.count * 3)
    this.recomputeColors()
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3))
    geometry.computeBoundingSphere()

    // Material — same as aaa/
    const material = new THREE.PointsMaterial({
      size: 0.1 * this.pointSizeMultiplier,
      vertexColors: true,
      sizeAttenuation: true,
    })

    if (this.pointsMesh) this.scene.remove(this.pointsMesh)
    this.pointsMesh = new THREE.Points(geometry, material)
    this.scene.add(this.pointsMesh)

    // Fit camera
    const center = geometry.boundingSphere!.center
    const radius = geometry.boundingSphere!.radius
    this.boundRadius = radius

    this.controls.target.copy(center)
    this.camera.position.set(center.x + radius * 0.8, center.y + radius * 0.5, center.z + radius * 0.8)
    this.camera.near = radius * 0.001
    this.camera.far = radius * 100
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  updateData(data: PointCloudData): void {
    // Update without resetting camera
    this.data = data
    this.highlightBuf = null
    this.origColArr = null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))

    this.colArr = new Float32Array(data.count * 3)
    this.recomputeColors()
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colArr, 3))

    const material = new THREE.PointsMaterial({
      size: 0.1 * this.pointSizeMultiplier,
      vertexColors: true,
      sizeAttenuation: true,
    })

    if (this.pointsMesh) this.scene.remove(this.pointsMesh)
    this.pointsMesh = new THREE.Points(geometry, material)
    this.scene.add(this.pointsMesh)
  }

  setColorMode(mode: string): void {
    this.colorMode = mode
    this.recomputeColors()
    this.applyHighlight()
    this.pushColors()
  }

  setPointSize(multiplier: number): void {
    this.pointSizeMultiplier = multiplier
    if (this.pointsMesh) {
      ;(this.pointsMesh.material as THREE.PointsMaterial).size = 0.1 * multiplier
    }
  }

  setController(enabled: boolean): void {
    this.controls.enabled = enabled
  }

  setViewPreset(preset: string): void {
    const t = this.controls.target
    const r = this.boundRadius
    const views: Record<string, [number, number, number]> = {
      persp: [0.8, 0.5, 0.8],
      top: [0, 1, 0.01],
      bottom: [0, -1, 0.01],
      front: [0, 0.1, 1],
      back: [0, 0.1, -1],
      right: [1, 0.1, 0],
      left: [-1, 0.1, 0],
    }
    const [dx, dy, dz] = views[preset] ?? [0.8, 0.5, 0.8]
    this.camera.position.set(t.x + dx * r, t.y + dy * r, t.z + dz * r)
    this.controls.update()
  }

  setHighlight(highlight: Uint8Array | null): void {
    this.highlightBuf = highlight
    if (!highlight) {
      // Restore original colors
      if (this.origColArr && this.colArr) this.colArr.set(this.origColArr)
    }
    else {
      this.applyHighlight()
    }
    this.pushColors()
  }

  /** Get viewProjectionMatrix for selection */
  getProjectionInfo(): { m: Float64Array } | null {
    if (!this.pointsMesh) return null
    this.camera.updateMatrixWorld()
    const mvp = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    return { m: new Float64Array(mvp.elements) }
  }

  getViewportSize(): { width: number, height: number } {
    return { width: this.container.clientWidth, height: this.container.clientHeight }
  }

  getViewProjectionMatrix(): number[] | null {
    const info = this.getProjectionInfo()
    return info ? Array.from(info.m) : null
  }

  getPixelProjectionMatrix(): Float64Array | null {
    return this.getProjectionInfo()?.m ?? null
  }

  dispose(): void {
    cancelAnimationFrame(this.animId)
    window.removeEventListener('resize', this.onResize)
    this.controls.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private recomputeColors(): void {
    if (!this.data || !this.colArr) return
    computeColors(this.data, this.colorMode, this.colArr)
    this.origColArr = new Float32Array(this.colArr)
  }

  private applyHighlight(): void {
    if (!this.highlightBuf || !this.colArr || !this.origColArr || !this.data) return
    // Restore base colors first
    this.colArr.set(this.origColArr)
    // Overlay selected points in orange
    for (let i = 0; i < this.data.count; i++) {
      if (this.highlightBuf[i]) {
        this.colArr[i * 3] = 1.0
        this.colArr[i * 3 + 1] = 0.4
        this.colArr[i * 3 + 2] = 0.1
      }
    }
  }

  private pushColors(): void {
    if (!this.pointsMesh || !this.colArr) return
    const attr = this.pointsMesh.geometry.getAttribute('color') as THREE.BufferAttribute
    attr.array.set(this.colArr)
    attr.needsUpdate = true
  }

  private animate = (): void => {
    this.animId = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }
}
