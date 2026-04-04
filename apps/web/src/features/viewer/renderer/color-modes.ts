// ---------------------------------------------------------------------------
// Color mode definitions and classification palette
// ---------------------------------------------------------------------------

export enum ColorMode {
  RGB = 0,
  Intensity = 1,
  Height = 2,
  Classification = 3,
  White = 4,
}

export const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  [ColorMode.RGB]: 'RGB',
  [ColorMode.Intensity]: 'Intensity',
  [ColorMode.Height]: 'Height',
  [ColorMode.Classification]: 'Classification',
  [ColorMode.White]: 'White',
}

/**
 * LAS standard classification colors (class index → [R, G, B] 0–255).
 * Based on ASPRS LAS 1.4 standard classification values.
 */
export const CLASSIFICATION_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [200, 200, 200], //  0 — Never classified / Created
  [128, 128, 128], //  1 — Unassigned
  [170, 119, 34], //  2 — Ground
  [0, 153, 0], //  3 — Low vegetation
  [0, 204, 0], //  4 — Medium vegetation
  [0, 255, 0], //  5 — High vegetation
  [255, 0, 0], //  6 — Building
  [255, 127, 0], //  7 — Low point (noise)
  [255, 0, 255], //  8 — Reserved / Model key-point
  [0, 0, 255], //  9 — Water
  [128, 128, 255], // 10 — Rail
  [0, 0, 0], // 11 — Road surface
  [255, 255, 0], // 12 — Reserved / Overlap
  [0, 200, 255], // 13 — Wire – Guard
  [0, 128, 255], // 14 — Wire – Conductor
  [128, 0, 128], // 15 — Transmission tower
  [0, 200, 200], // 16 — Wire – Connector
  [128, 0, 64], // 17 — Bridge deck
  [255, 200, 200], // 18 — High noise
]

/**
 * Build a Float32Array palette texture data (256 × 1 RGBA, values in 0–1).
 * Classes beyond the table length fall back to magenta.
 */
export function buildClassificationPalette(): Float32Array {
  const size = 256
  const data = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) {
    const base = i * 4
    if (i < CLASSIFICATION_COLORS.length) {
      const c = CLASSIFICATION_COLORS[i]!
      data[base] = c[0] / 255
      data[base + 1] = c[1] / 255
      data[base + 2] = c[2] / 255
    }
    else {
      // Fallback: magenta
      data[base] = 1.0
      data[base + 1] = 0.0
      data[base + 2] = 1.0
    }
    data[base + 3] = 1.0
  }
  return data
}
