import type { ReactNode } from 'react'
import css from './Card.module.css'

/** 卡片表面：`card`＝settings 卡片底；`form`＝浮层底（表单容器）。 */
export type CardVariant = 'card' | 'form'

export interface CardProps {
  variant?: CardVariant
  /** 布局放置（外层布局由调用方决定）。 */
  className?: string | undefined
  children?: ReactNode
}

/**
 * 卡片容器。内核 `ui-primitives` 无通用卡片原子，故在组合层补齐：
 * 只提供表面与内部纵向布局，内容与交互由调用方决定。
 * 样式走 `Card.module.css`（构建期编译成幂等 style 注入）。
 * @param props.variant - 表面（默认 `card`）。
 * @param props.className - 布局放置。
 * @returns 卡片元素。
 */
export function Card({ variant = 'card', className, children }: CardProps) {
  const cls = variant === 'form' ? `${css.card} ${css.form}` : css.card
  return <div className={className === undefined ? cls : `${cls} ${className}`}>{children}</div>
}
