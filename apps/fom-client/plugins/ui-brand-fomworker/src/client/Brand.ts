import { createElement } from 'react'
import { BRAND_AMBER, BRAND_BLUE, BRAND_INK, MARK_ARROW, MARK_BAR, MARK_BLUE, MARK_VIEWBOX } from './mark.ts'

/**
 * FomWorker 品牌标记（据 `fom-logo.png` 手绘的 SVG 近似）。
 * 组成：蓝色「C/立方」+ 琥珀上右箭头 + 琥珀竖条。⚠️ 近似版；拿到矢量源后应替换。
 */

function mark(size: number, className?: string) {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: MARK_VIEWBOX, className, 'aria-hidden': 'true' },
    createElement('path', { key: 'blue', d: MARK_BLUE, fill: BRAND_BLUE }),
    createElement('path', { key: 'arrow', d: MARK_ARROW, fill: BRAND_AMBER }),
    createElement('path', { key: 'bar', d: MARK_BAR, fill: BRAND_AMBER }),
  )
}

/**
 * 侧栏 logo（占 `sidebar.brand.mark`）。
 * @param props.size - 请求的方形边长（px）。
 */
export function FomMark({ size }: { size: number }) {
  return mark(size)
}

/** 侧栏名称（占 `sidebar.brand.name`）。品牌墨色文字，非产品文案。 */
export function FomName() {
  return createElement(
    'span',
    { style: { fontWeight: 700, letterSpacing: '0.01em', color: BRAND_INK, fontSize: 15 } },
    'FomWorker',
  )
}

/**
 * 聊天页 hero 标志（占 `conversation.hero.brand.mark`）。阶段1 静态。
 * @param props.size - 请求的方形边长（px）。
 * @param props.className - 宿主类（保留周边几何）。
 */
export function FomHeroMark({ size, className }: { size: number; className?: string }) {
  return mark(size, className)
}
