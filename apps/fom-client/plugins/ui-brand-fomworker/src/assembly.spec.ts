/**
 * 品牌槽位的装配：必须用更低的 priority 压过官方 `ui-brand-official`。
 *
 * ## 为什么钉这条（2026-10-21 实装事故）
 *
 * `sidebar.brand.mark` / `.name` 是 **single** 槽位，官方 `ui-brand-official` 也在里面注册，
 * 且它所在的 `dsh-web-app` 层**先于**我们的 bundle 层。`ui-slots` 对同一 priority 的第二次
 * 注册直接抛错 ⇒ 我们的插件被标成失败、槽位保留官方内容 ⇒ 装完界面仍是 `deepseek HARNESS`。
 *
 * 也就是说：**这个插件「在产物里」「被加载了」，但注册失败**，而界面看不出原因。用源码
 * 断言钉住 priority，比等实装发现要便宜得多。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'client', 'index.ts'), 'utf8')

describe('brand slot assembly', () => {
  it('registers all three brand slots', () => {
    expect(source).toContain("'sidebar.brand.mark'")
    expect(source).toContain("'sidebar.brand.name'")
    expect(source).toContain("'conversation.hero.brand.mark'")
  })

  it('shadows the official registration with a negative priority', () => {
    // 官方 ui-brand-official 用默认 priority 0；同 priority 会抛错而不是共存。
    const constant = /const SHADOW_OFFICIAL = (-?\d+)/u.exec(source)
    expect(constant).not.toBeNull()
    expect(Number(constant![1])).toBeLessThan(0)

    // 三个注册点都要带上它，漏一个那个槽位就仍然显示官方内容。
    const registrations = [...source.matchAll(/slots\.register\(\{ name: '([a-z.]+)'([^}]*)\}/gu)]
    expect(registrations.length).toBe(3)
    for (const [, name, rest] of registrations) {
      expect(rest, `${name} 必须带 priority`).toContain('priority: SHADOW_OFFICIAL')
    }
  })
})
