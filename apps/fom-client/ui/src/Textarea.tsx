import { forwardRef, type TextareaHTMLAttributes } from 'react'
import css from './Textarea.module.css'

/**
 * 多行文本输入。内核 `ui-primitives` 无此原子（`Input` 是单行、`InlineEditor` 是行内短草稿），
 * 故在组合层补齐；样式走 `Textarea.module.css`，与 `Input` 对齐。
 * @param ref - 原生 textarea，供焦点控制。
 * @returns textarea 元素；原生属性透传。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={className === undefined ? css.textarea : `${css.textarea} ${className}`} {...rest} />
  },
)
