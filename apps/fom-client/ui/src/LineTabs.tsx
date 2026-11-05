import type { KeyboardEvent, ReactNode } from 'react'
import css from './LineTabs.module.css'

/** 一个 line 型 tab：`value` 是选中值，`id`/`panelId` 供 `aria-controls` 指向面板。 */
export interface LineTab<Value extends string = string> {
  value: Value
  label: ReactNode
  id: string
  panelId: string
}

/** 走位键（WAI-ARIA tabs 模式）。 */
function isWalkKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End'
}

/**
 * **line 型 tabs**（顶级导航用）。内核 `ui-primitives` 只有分段（`SegmentedTabs`）⇒ 本组合层自建，
 * 样式照内核内部两处本地实现（`ui-conversation/ConversationRoot` 与 `ui-settings-plugins/PluginsSettingsSection`）：
 * **发丝底边 + 2px 下划线**（选中/聚焦），active 色取品牌 `--dsw-alias-state-business-primary`。
 *
 * 层次用法：**line tab（顶级）> segment（视图切换）> pill（筛选）**。
 * @param props.items - 非空有序 tab（`value` 唯一、`id`/`panelId` 唯一）。
 * @param props.value - 选中值（须属于 items）；受控。
 * @param props.onChange - 点击/方向键请求的选中值。
 * @param props.label - 本地化的 tablist 无障碍名。
 * @param props.className - 布局放置；面板由调用方渲染。
 * @returns tablist 元素（不含面板）。
 */
export function LineTabs<Value extends string>({ items, value, onChange, label, className }: {
  items: readonly [LineTab<Value>, ...LineTab<Value>[]]
  value: Value
  onChange: (value: Value) => void
  label: string
  className?: string | undefined
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!isWalkKey(event.key)) return
    event.preventDefault()
    const last = items.length - 1
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break
      case 'ArrowRight': next = index === last ? 0 : index + 1; break
      case 'Home': next = 0; break
      default: next = last; break
    }
    const target = items[next]
    const list = event.currentTarget.parentElement
    if (target === undefined || list === null) return
    list.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(next).focus()
    onChange(target.value)
  }

  return (
    <div role="tablist" aria-label={label} className={className === undefined ? css.tabs : `${css.tabs} ${className}`}>
      {items.map((item, index) => {
        const active = item.value === value
        return (
          <button
            key={item.value}
            id={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={item.panelId}
            tabIndex={active ? 0 : -1}
            data-active={active ? 'true' : undefined}
            className={css.tab}
            onClick={() => {
              if (!active) onChange(item.value)
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index)
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
