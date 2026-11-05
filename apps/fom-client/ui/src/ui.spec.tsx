import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Card, Textarea } from './index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const HEX = /#[0-9a-fA-F]{3,8}\b/

/** 取出首个 class 属性值。 */
function classesOf(html: string): string {
  return html.split('class="')[1]?.split('"')[0] ?? ''
}

describe('@fominfo/dsh-ui', () => {
  it('Card 渲染子节点并挂上模块类名', () => {
    const html = renderToStaticMarkup(
      <Card>
        <span>hi</span>
      </Card>,
    )
    expect(html).toContain('hi')
    expect(classesOf(html)).toContain('_card')
  })

  it('Card 的 form 变体挂基础类 + 修饰类', () => {
    const cls = classesOf(renderToStaticMarkup(<Card variant="form">x</Card>))
    expect(cls).toContain('_card')
    expect(cls).toContain('_form')
    expect(cls.split(' ').length).toBe(2)
  })

  it('Card 透传 className', () => {
    expect(classesOf(renderToStaticMarkup(<Card className="extra">x</Card>))).toContain('extra')
  })

  it('Textarea 透传原生属性并挂模块类名', () => {
    const html = renderToStaticMarkup(<Textarea rows={5} placeholder="正文" />)
    expect(html).toContain('rows="5"')
    expect(html).toContain('placeholder="正文"')
    expect(classesOf(html)).toContain('_textarea')
  })

  it('样式表只用 --dsw-alias-* 令牌，无颜色字面量', () => {
    for (const file of ['Card.module.css', 'Textarea.module.css', 'LineTabs.module.css']) {
      const css = readFileSync(join(here, file), 'utf8')
      expect(css).toContain('--dsw-alias-')
      expect(css).not.toMatch(HEX)
    }
  })
})
