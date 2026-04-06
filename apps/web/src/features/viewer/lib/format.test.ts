import { describe, expect, it } from 'vitest'
import { formatMillions, formatPointCount } from './format'

describe('formatPointCount', () => {
  it('formats millions', () => {
    expect(formatPointCount(2_300_000)).toBe('2.3M')
    expect(formatPointCount(1_000_000)).toBe('1.0M')
    expect(formatPointCount(10_500_000)).toBe('10.5M')
  })

  it('formats thousands', () => {
    expect(formatPointCount(1_500)).toBe('1.5K')
    expect(formatPointCount(999_999)).toBe('1000.0K')
    expect(formatPointCount(1_000)).toBe('1.0K')
  })

  it('formats small numbers as-is', () => {
    expect(formatPointCount(0)).toBe('0')
    expect(formatPointCount(999)).toBe('999')
    expect(formatPointCount(1)).toBe('1')
  })
})

describe('formatMillions', () => {
  it('formats number as millions', () => {
    expect(formatMillions(4_000_000)).toBe('4.0M')
    expect(formatMillions(2_500_000)).toBe('2.5M')
    expect(formatMillions(10_000_000)).toBe('10.0M')
  })
})
