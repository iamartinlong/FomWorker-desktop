/**
 * profile patch 文本手术的验收（T5b）。
 *
 * 最关键的两条：① **别人的条目一个字都不能动**（这是纯文本手术的唯一风险点）；
 * ② 手术异常时**抛**而不是写坏文件（条数变少就说明误判了边界）。
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countEntries,
  findEntrySpan,
  profilePatchPath,
  renderPatchEntry,
  upsertPatchEntry,
} from './profile-patch.ts'

/** 一份「别人已经写过东西」的 patch（形状照真实用户 patch：多条 + 嵌套 + 注释）。 */
const EXISTING = `# Your patch layer for this dsh profile, applied after every bundle layer:
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      stepfun-plan:
        apiKeyEnv: STEPFUN_PLAN_API_KEY
        baseURL: https://api.stepfun.com/step_plan/v1
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: stepfun-plan
`

describe('profile-patch · 生成条目', () => {
  it('一条完整的 office-feishu 配置条目', () => {
    const text = renderPatchEntry('office-feishu', '@office/feishu', {
      feishuAppId: 'cli_a1b2', readOnly: true, baseUrl: '',
    })
    expect(text).toBe([
      '- id: office-feishu',
      "  name: '@office/feishu'",
      '  config:',
      '    feishuAppId: cli_a1b2',
      '    readOnly: true',
      '    baseUrl: ' + "''",
      '',
    ].join('\n'))
  })

  it('URL 不加引号、`冒号+空格` 才加（与 connector-bundle 同规则）', () => {
    const text = renderPatchEntry('x', '@office/x', { url: 'https://a.b/mcp', odd: 'has: colon' })
    expect(text).toContain('url: https://a.b/mcp')
    expect(text).toContain("odd: 'has: colon'")
  })
})

describe('profile-patch · 文本手术', () => {
  it('没有同 id 条目 ⇒ 追加到末尾，别人的一字不动', () => {
    const next = upsertPatchEntry(EXISTING, 'office-feishu', renderPatchEntry('office-feishu', '@office/feishu', { feishuAppId: 'cli_x' }))
    // 别人的三条原文逐字还在
    expect(next).toContain('- id: ui-chat')
    expect(next).toContain('- id: llm-pi-ai')
    expect(next).toContain('- id: agent-default-model')
    expect(next).toContain('    baseURL: https://api.stepfun.com/step_plan/v1')
    // 新的在最后
    expect(next.trimEnd().endsWith("feishuAppId: cli_x")).toBe(true)
    expect(countEntries(next)).toBe(4)
  })

  it('已有同 id 条目 ⇒ 整条替换，前后邻居完整保留', () => {
    const once = upsertPatchEntry(EXISTING, 'office-feishu', renderPatchEntry('office-feishu', '@office/feishu', { feishuAppId: 'cli_1' }))
    const twice = upsertPatchEntry(once, 'office-feishu', renderPatchEntry('office-feishu', '@office/feishu', { feishuAppId: 'cli_2', readOnly: true }))
    expect(countEntries(twice)).toBe(4)
    expect(twice).toContain('feishuAppId: cli_2')
    expect(twice).not.toContain('feishuAppId: cli_1')
    // 前后邻居（ui-chat 在头、agent-default-model 在尾）都还在
    expect(twice).toContain('- id: ui-chat')
    expect(twice).toContain('    provider: stepfun-plan')
    // 头注释也还在
    expect(twice.startsWith('# Your patch layer')).toBe(true)
  })

  it('目标是最后一条 ⇒ 替换到文件尾（不会把结尾换行吃掉）', () => {
    const next = upsertPatchEntry(EXISTING, 'agent-default-model', renderPatchEntry('agent-default-model', '@x/y', { model: 'other' }))
    expect(next).toContain('model: other')
    // 被替换那条的旧值没了（`provider: stepfun-plan` 只属于它）
    expect(next).not.toContain('provider: stepfun-plan')
    // 但邻居 llm-pi-ai 里同名的 `stepfun-plan:`（嵌套键）必须原样留着
    expect(next).toContain('      stepfun-plan:')
    expect(countEntries(next)).toBe(3)
  })

  it('目标是第一条 ⇒ 只换第一条', () => {
    const next = upsertPatchEntry(EXISTING, 'ui-chat', renderPatchEntry('ui-chat', '@x/y', { a: 'b' }))
    expect(countEntries(next)).toBe(3)
    expect(next).toContain('- id: ui-chat')
    expect(next).toContain('    a: b')
    expect(next).toContain('- id: llm-pi-ai')
  })

  it('空文件 ⇒ 直接写成一条', () => {
    const next = upsertPatchEntry('', 'office-feishu', renderPatchEntry('office-feishu', '@office/feishu', { feishuAppId: 'cli_x' }))
    expect(countEntries(next)).toBe(1)
    expect(next).toContain('feishuAppId: cli_x')
  })

  it('findEntrySpan 找得到/找不到', () => {
    // EXISTING 的行号：0 注释 / 1 ui-chat / 5 llm-pi-ai / 13 agent-default-model
    expect(findEntrySpan(EXISTING, 'llm-pi-ai')?.start).toBe(5)
    expect(findEntrySpan(EXISTING, 'ui-chat')?.start).toBe(1)
    expect(findEntrySpan(EXISTING, 'nope')).toBeUndefined()
  })

  it('profilePatchPath：<home>/profiles/<profile>/cordis.patch.yml', () => {
    expect(profilePatchPath('D:\\x')).toBe(join('D:\\x', 'profiles', 'desktop', 'cordis.patch.yml'))
    expect(profilePatchPath('D:\\x', 'web')).toBe(join('D:\\x', 'profiles', 'web', 'cordis.patch.yml'))
  })
})
