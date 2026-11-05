import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isValidExpertId,
  listExpertDeltas,
  parseExpertDelta,
  readExpertDelta,
  removeExpertDelta,
  writeExpertDelta,
  type ExpertDelta,
} from './delta.ts'

const sample: ExpertDelta = {
  id: 'contract-review',
  name: '合同审阅',
  description: '逐条审合同',
  persona: { prefix: '你是资深法务' },
  tools: { enable: ['plan-mode'], disable: ['tool-web'] },
  skills: ['meeting-minutes'],
}

describe('office-experts · 专家 delta', () => {
  it('id 校验（拒大写 / 穿越 / 空）', () => {
    expect(isValidExpertId('contract-review')).toBe(true)
    expect(isValidExpertId('A')).toBe(false)
    expect(isValidExpertId('../x')).toBe(false)
    expect(isValidExpertId('')).toBe(false)
  })

  it('parse：合法 delta 带人设与勾选', () => {
    const result = parseExpertDelta(sample)
    expect(result.problems).toEqual([])
    expect(result.delta?.id).toBe('contract-review')
    expect(result.delta?.persona.prefix).toBe('你是资深法务')
    expect(result.delta?.tools.enable).toEqual(['plan-mode'])
    expect(result.delta?.skills).toEqual(['meeting-minutes'])
  })

  it('parse：坏 id / 缺 name / 非对象', () => {
    expect(parseExpertDelta({ id: 'A', name: 'x' }).problems.some((p) => p.includes('id 非法'))).toBe(true)
    expect(parseExpertDelta({ id: 'a' }).problems).toContain('缺 name')
    expect(parseExpertDelta(null).problems).toContain('delta 不是对象')
  })

  describe('文件往返', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fom-experts-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('write→list→read→remove', () => {
      writeExpertDelta(dir, sample)
      expect(listExpertDeltas(dir)).toEqual(['contract-review'])
      expect(readExpertDelta(dir, 'contract-review')?.name).toBe('合同审阅')
      expect(removeExpertDelta(dir, 'contract-review')).toBe(true)
      expect(removeExpertDelta(dir, 'contract-review')).toBe(false)
      expect(listExpertDeltas(dir)).toEqual([])
    })

    it('write 非法 id 抛', () => {
      expect(() => writeExpertDelta(dir, { ...sample, id: 'A' })).toThrow(/非法专家 id/)
    })

    it('read 不存在 → undefined；空目录 list 为空', () => {
      expect(readExpertDelta(dir, 'nope')).toBeUndefined()
      expect(listExpertDeltas(dir)).toEqual([])
    })
  })
})
