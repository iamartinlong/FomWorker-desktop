/**
 * FomWorker 客户端共享 UI 组合层。
 *
 * 原则（见 `docs/02-设计/前端技术栈与页面实现规范v0.1.md` §3.5/§3.6）：
 * - **组合内核原子**（`@deepseek-ai/dsh-client-ui-primitives`），不 fork、不引第三方组件库；
 * - 颜色一律走 `--dsw-alias-*` 语义令牌，**不写颜色字面量**；
 * - 只补内核**没有**的原子（`Textarea` / `Card`）。
 */

export { Textarea } from './Textarea.tsx'
export { Card } from './Card.tsx'
export type { CardProps, CardVariant } from './Card.tsx'
export { LineTabs } from './LineTabs.tsx'
export type { LineTab } from './LineTabs.tsx'
