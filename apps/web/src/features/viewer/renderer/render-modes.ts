import type { BlendMode, PointShape } from './tile-mesh'

export type RenderModeId = 'points' | 'shaded' | 'smooth' | 'xray'

export interface RenderMode {
  id: RenderModeId
  label: string
  pointShape: PointShape
  edlEnabled: boolean
  sizingMultiplier: number
  blendMode: BlendMode
  ssaoEnabled: boolean
  depthWrite: boolean
}

export const RENDER_MODES: Record<RenderModeId, RenderMode> = {
  points: {
    id: 'points',
    label: 'Points',
    pointShape: 'circle',
    edlEnabled: false,
    sizingMultiplier: 1.0,
    blendMode: 'opaque',
    ssaoEnabled: false,
    depthWrite: true,
  },
  shaded: {
    id: 'shaded',
    label: 'Shaded',
    pointShape: 'circle',
    edlEnabled: true,
    sizingMultiplier: 1.0,
    blendMode: 'opaque',
    ssaoEnabled: false,
    depthWrite: true,
  },
  smooth: {
    id: 'smooth',
    label: 'Smooth',
    pointShape: 'gaussian',
    edlEnabled: true,
    sizingMultiplier: 1.5,
    blendMode: 'alpha',
    ssaoEnabled: true,
    depthWrite: false,
  },
  xray: {
    id: 'xray',
    label: 'X-Ray',
    pointShape: 'circle',
    edlEnabled: false,
    sizingMultiplier: 0.5,
    blendMode: 'additive',
    ssaoEnabled: false,
    depthWrite: false,
  },
}
