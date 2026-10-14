import { describe, expect, it } from 'vitest'
import { BRAND_AMBER, BRAND_BLUE, BRAND_INK, MARK_ARROW, MARK_BAR, MARK_BLUE, MARK_VIEWBOX } from './mark.ts'

const HEX = /^#[0-9A-Fa-f]{6}$/

describe('brand mark geometry', () => {
  it('色值为 6 位 hex 且符合品牌 tokens', () => {
    for (const c of [BRAND_BLUE, BRAND_AMBER, BRAND_INK]) expect(c).toMatch(HEX)
    expect(BRAND_BLUE).toBe('#038AC6')
    expect(BRAND_AMBER).toBe('#FCB513')
    expect(BRAND_INK).toBe('#4E4B47')
  })

  it('viewBox 为 64×64', () => {
    expect(MARK_VIEWBOX).toBe('0 0 64 64')
  })

  it('三段路径均为闭合多边形（M 起、Z 收、含 ≥4 顶点）', () => {
    for (const d of [MARK_BLUE, MARK_ARROW, MARK_BAR]) {
      expect(d.startsWith('M')).toBe(true)
      expect(d.trimEnd().endsWith('Z')).toBe(true)
      expect(d.split('L').length).toBeGreaterThanOrEqual(4)
    }
  })
})
