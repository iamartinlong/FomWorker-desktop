import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineTabs } from './LineTabs.tsx'

const items = [
  { value: 'a', label: '甲', id: 't-a', panelId: 'p-a' },
  { value: 'b', label: '乙', id: 't-b', panelId: 'p-b' },
  { value: 'c', label: '丙', id: 't-c', panelId: 'p-c' },
] as const

describe('@fominfo/dsh-ui · LineTabs', () => {
  it('渲染 tablist / role=tab / aria-selected / aria-controls / roving tabindex', () => {
    const html = renderToStaticMarkup(<LineTabs items={items} value="b" onChange={() => {}} label="类型" />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="类型"')
    expect((html.match(/role="tab"/gu) ?? []).length).toBe(3)
    // 只有选中项是 tab stop + data-active + aria-selected=true
    expect((html.match(/aria-selected="true"/gu) ?? []).length).toBe(1)
    expect((html.match(/data-active="true"/gu) ?? []).length).toBe(1)
    expect((html.match(/tabindex="0"/gu) ?? []).length).toBe(1)
    expect((html.match(/tabindex="-1"/gu) ?? []).length).toBe(2)
    expect(html).toContain('aria-controls="p-b"')
    expect(html).toContain('id="t-b"')
  })

  it('label 支持 ReactNode（含计数）', () => {
    const withCount = [{ value: 'a', label: <span>技能 (3)</span>, id: 't-a', panelId: 'p-a' }] as const
    expect(renderToStaticMarkup(<LineTabs items={withCount} value="a" onChange={() => {}} label="t" />)).toContain('技能 (3)')
  })
})
