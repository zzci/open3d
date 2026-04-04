// ---------------------------------------------------------------------------
// Palette registry — cached DataTexture singletons per palette
// ---------------------------------------------------------------------------

import { DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three'
import {
  buildCividis,
  buildGrayscale,
  buildInferno,
  buildPlasma,
  buildTurbo,
  buildViridis,
} from './palette-data'

export enum PaletteId {
  Grayscale = 'grayscale',
  Viridis = 'viridis',
  Turbo = 'turbo',
  Inferno = 'inferno',
  Plasma = 'plasma',
  Cividis = 'cividis',
}

export const PALETTE_LABELS: Record<PaletteId, string> = {
  [PaletteId.Grayscale]: 'Grayscale',
  [PaletteId.Viridis]: 'Viridis',
  [PaletteId.Turbo]: 'Turbo',
  [PaletteId.Inferno]: 'Inferno',
  [PaletteId.Plasma]: 'Plasma',
  [PaletteId.Cividis]: 'Cividis',
}

const PALETTE_BUILDERS: Record<PaletteId, () => Float32Array> = {
  [PaletteId.Grayscale]: buildGrayscale,
  [PaletteId.Viridis]: buildViridis,
  [PaletteId.Turbo]: buildTurbo,
  [PaletteId.Inferno]: buildInferno,
  [PaletteId.Plasma]: buildPlasma,
  [PaletteId.Cividis]: buildCividis,
}

const cache = new Map<PaletteId, DataTexture>()

/** Get (or create) a cached 256x1 RGBA DataTexture for the given palette. */
export function getPaletteTexture(id: PaletteId): DataTexture {
  let tex = cache.get(id)
  if (tex)
    return tex

  const data = PALETTE_BUILDERS[id]()
  tex = new DataTexture(data, 256, 1, RGBAFormat, FloatType)
  tex.minFilter = LinearFilter
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  cache.set(id, tex)
  return tex
}

/** Dispose all cached palette textures. Call on renderer teardown. */
export function disposePalettes(): void {
  for (const tex of cache.values()) {
    tex.dispose()
  }
  cache.clear()
}
