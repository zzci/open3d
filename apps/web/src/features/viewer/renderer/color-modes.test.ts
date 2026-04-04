import { describe, expect, it } from 'vitest'
import { buildClassificationPalette, CLASSIFICATION_COLORS, COLOR_MODE_LABELS, ColorMode } from './color-modes'

describe('colorMode enum', () => {
  it('has correct integer values for shader uniform', () => {
    expect(ColorMode.RGB).toBe(0)
    expect(ColorMode.Intensity).toBe(1)
    expect(ColorMode.Height).toBe(2)
    expect(ColorMode.Classification).toBe(3)
    expect(ColorMode.White).toBe(4)
  })

  it('has labels for all modes', () => {
    expect(COLOR_MODE_LABELS[ColorMode.RGB]).toBe('RGB')
    expect(COLOR_MODE_LABELS[ColorMode.Intensity]).toBe('Intensity')
    expect(COLOR_MODE_LABELS[ColorMode.Height]).toBe('Height')
    expect(COLOR_MODE_LABELS[ColorMode.Classification]).toBe('Classification')
    expect(COLOR_MODE_LABELS[ColorMode.White]).toBe('White')
  })
})

describe('cLASSIFICATION_COLORS', () => {
  it('has at least 19 entries (LAS standard classes 0–18)', () => {
    expect(CLASSIFICATION_COLORS.length).toBeGreaterThanOrEqual(19)
  })

  it('has RGB tuples in 0–255 range', () => {
    for (const [r, g, b] of CLASSIFICATION_COLORS) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(255)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(255)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(255)
    }
  })
})

describe('buildClassificationPalette', () => {
  it('returns a Float32Array of 256 * 4 = 1024 elements', () => {
    const palette = buildClassificationPalette()
    expect(palette).toBeInstanceOf(Float32Array)
    expect(palette.length).toBe(256 * 4)
  })

  it('maps known classes to correct normalized RGB', () => {
    const palette = buildClassificationPalette()
    // Class 2 = Ground = [170, 119, 34]
    expect(palette[2 * 4]).toBeCloseTo(170 / 255, 3)
    expect(palette[2 * 4 + 1]).toBeCloseTo(119 / 255, 3)
    expect(palette[2 * 4 + 2]).toBeCloseTo(34 / 255, 3)
    expect(palette[2 * 4 + 3]).toBe(1.0) // alpha
  })

  it('uses magenta for classes beyond the table', () => {
    const palette = buildClassificationPalette()
    // Class 200 — should be fallback magenta
    const base = 200 * 4
    expect(palette[base]).toBe(1.0) // R
    expect(palette[base + 1]).toBe(0.0) // G
    expect(palette[base + 2]).toBe(1.0) // B
    expect(palette[base + 3]).toBe(1.0) // A
  })

  it('sets all alpha values to 1.0', () => {
    const palette = buildClassificationPalette()
    for (let i = 0; i < 256; i++) {
      expect(palette[i * 4 + 3]).toBe(1.0)
    }
  })
})
