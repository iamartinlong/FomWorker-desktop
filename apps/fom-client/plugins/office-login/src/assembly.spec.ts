/**
 * 浏览器半的槽位装配：左下角只有一个入口、账号页在设置面板里。
 *
 * ## 为什么用源码断言而不是渲染测试（2026-10-21）
 *
 * 本仓 `apps/fom-client` 没有组件测试基础设施（无 jsdom + React 解析配置），而这一轮要钉住的
 * 恰恰是**装配形状**：注册了哪些槽位、优先级是多少、旧槽位是否已移除。这些都在 `apply` 的
 * 源码里，静态断言既精确又不需要渲染。
 *
 * 背景：原有测试**完全没覆盖槽位注册**，所以删掉一整行 UI、换掉一个槽位，测试全绿。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'client', 'index.tsx'), 'utf8')

describe('office-login client assembly', () => {
  it('registers the gate, the single launcher, and the account section', () => {
    expect(source).toContain("'shell.overlay'")
    expect(source).toContain("'settings.launcher'")
    expect(source).toContain("'settings.section'")
  })

  it('no longer registers a separate sidebar footer row', () => {
    // 旧的独立账号行与「更多」并列，左下角会变成两个同级入口（用户明确否掉）。
    expect(source).not.toContain("'sidebar.footer.action'")
  })

  it('shadows the shipped launcher with a lower priority', () => {
    // 官方 ui-settings-account 用默认 priority 0 注册；我们必须更低才会被渲染。
    const launcher = /name: 'settings\.launcher',[\s\S]{0,120}?priority: (-?\d+)/u.exec(source)
    expect(launcher).not.toBeNull()
    expect(Number(launcher![1])).toBeLessThan(0)
  })

  it('keeps its own account section id instead of the official one', () => {
    // 官方账号分区的 id 是 'account'（order -10）。我们不抢它，用自己的 id。
    const section = /name: 'settings\.section',[\s\S]{0,160}?id: '([a-z-]+)'/u.exec(source)
    expect(section).not.toBeNull()
    expect(section![1]).toBe('fomworker-account')
  })
})
